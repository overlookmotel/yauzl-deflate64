/* --------------------
 * yauzl-deflate64 module
 * Patch `.openReadStream()` method to add Deflate64 unzip capability
 * ------------------*/

'use strict';

// Modules
const {spawn} = require('child_process'),
	{PassThrough} = require('stream'),
	cloner = require('yauzl-clone');

// Constants
const FOUR_GIB = 0x100000000, // largest 32 bit integer + 1
	LFH_LENGTH = 30,
	LFH_SIGNATURE = 0x04034b50,
	// Compression methods
	COMPRESS_NONE = 0,
	COMPRESS_DEFLATE = 8,
	COMPRESS_DEFLATE64 = 9,
	// Compression method arrays
	COMPRESS_ALL = [COMPRESS_DEFLATE64],
	COMPRESS_FORCE_ALL = COMPRESS_ALL.concat([COMPRESS_DEFLATE]);

// Exports
module.exports = function(yauzl) {
	// Add constants to yauzl object
	Object.assign(yauzl, {
		COMPRESS_NONE, COMPRESS_DEFLATE, COMPRESS_DEFLATE64,
		COMPRESS_ALL, COMPRESS_FORCE_ALL
	});

	// Patch access methods to store `funzipMethods` + `funzipPath` options
	cloner.patchAll(yauzl, original => {
		return (path, totalSize, options, cb) => {
			original.call(this, path, totalSize, options, (err, zipFile) => {
				if (err) return cb(err);

				// Conform options
				let {funzip, funzipPath} = options;
				if (!funzip) {
					funzip = false;
				} else if (funzip === true) {
					funzip = COMPRESS_ALL;
				} else if (!Array.isArray(funzip)) {
					funzip = [funzip];
				}
				funzipPath = funzipPath ? funzipPath + '' : 'funzip';

				zipFile.funzip = funzip;
				zipFile.funzipPath = funzipPath;
				cb(null, zipFile);
			});
		};
	});

	// Patch `openReadStream` method to use funzip
	const {ZipFile} = yauzl,
		{openReadStream} = ZipFile.prototype;
	ZipFile.prototype.openReadStream = function(entry, options, cb) {
		// Conform options
		if (cb == null) {
			cb = options;
			options = {};
		} else if (!options) {
			options = {};
		}

		// Work out if should use funzip
		// NB If `start` or `end` options set, passes options
		// unchanged to original method which will throw error
		const {compressionMethod} = entry,
			{decompress} = options,
			hasDecompress = options.hasOwnProperty('decompress');
		let funzip = false;
		if (
			this.funzip &&
			this.funzip.indexOf(compressionMethod) != -1 &&
			(decompress == null || decompress === true) &&
			options.start == null && options.end == null
		) {
			funzip = true;
			entry.compressionMethod = 0;
			if (decompress) options.decompress = null;
			// TODO Find better way to prevent decompression
		}

		// Workarounds for yauzl issue #80 - errors if you try to stream content
		// of a file without decompression if compression method is not Deflate
		let noDecompress = false;
		if (compressionMethod != 0 && compressionMethod != 8) {
			if (decompress === false) {
				noDecompress = true;
				entry.compressionMethod = 0;
				options.decompress = null;
			} else if (!funzip && decompress === true) {
				noDecompress = true;
				options.decompress = null;
			}
		}

		// Open read stream
		openReadStream.call(this, entry, options, (err, stream) => {
			// Restore original values of `entry.compressionMethod` and `options.decompress`
			if (funzip || noDecompress) {
				entry.compressionMethod = compressionMethod;
				if (decompress != null) {
					options.decompress = decompress;
				} else if (!hasDecompress) {
					delete options.decompress;
				}
			}

			// Exit if error
			if (err) return cb(err);

			// If not using funzip, callback with stream unchanged
			if (!funzip) return cb(null, stream);

			// Pipe through funzip
			// NB No need to validate uncompressed size - funzip does this itself
			const outStream = throughFunzip(stream, entry, this.funzipPath);

			// Callback with new stream
			cb(null, outStream);
		});
	};

	// Return yauzl object
	return yauzl;
};

/*
 * throughFunzip
 * Creates child process running `funzip`.
 * `inStream` is piped into child process's stdin.
 * Child process's stdout is piped into `outStream`.
 * `outStream` is returned.
 * If funzip outputs an error or exits abnormally, 'error' event is emitted
 * on `outStream`.
 *
 * NB Cannot just return child process's stdout stream as that emits 'end'
 * event if funzip exits abnormally. Want output stream to emit only 'error'.
 */
function throughFunzip(inStream, entry, funzipPath) {
	// TODO Remove all `console.log` statements

	// Create output stream
	const outStream = new PassThrough();

	// Spawn funzip
	//console.log('spawning');
	const funzip = spawn(funzipPath);
	const {stdin, stdout, stderr} = funzip;

	// Pipe child process stdout to outStream
	// NB `{end: false}` to prevent outStream emitting 'end' when stdout ends
	//console.log('piping stdout to outStream');
	stdout.pipe(outStream, {end: false});

	/*
	 * Event handlers
	 * 'end' or 'error' event will only be emitted on output stream when all
	 * resources closed:
	 *   - Input stream ended
	 *   - Child process closed
	 *   - Child process stdout ended
	 *
	 * In case of an error:
	 *   - Destroy input stream
	 *   - Kill child process
	 *   - Unpipe input and output streams from child process
	 */
	let inStreamPiped = false,
		inStreamEnded = false,
		inStreamDestroyed = false,
		stdoutPiped = true,
		stdoutEnded = false,
		childClosed = false,
		childKilled = false,
		errored = false,
		error = null;

	function failed(err) {
		if (errored) return;
		errored = true;

		//console.log('failed:', err);
		// Store error
		error = err;

		close();
	}

	function close() {
		//console.log('close');
		// Close down all resources
		if (inStreamPiped) {
			inStreamPiped = false;
			inStream.unpipe(stdin);
		}

		if (!inStreamEnded && !inStreamDestroyed) {
			inStreamDestroyed = true;
			inStream.destroy();
		}

		if (stdoutPiped && !stdoutEnded) {
			stdoutPiped = false;
			stdout.unpipe(outStream);
		}

		if (childClosed && !childKilled) {
			childKilled = true;
			funzip.kill();
		}
	}

	function endIfAllDone() {
		//console.log('endIfAllDone:', {inStreamEnded, childClosed, stdoutEnded});
		if (!inStreamEnded || !childClosed || !stdoutEnded) return;

		//console.log('done:', error);
		if (errored) return outStream.emit('error', error);
		outStream.emit('end');
	}

	// Input stream handlers
	inStream.on('end', () => {
		//console.log('inStream end');
		inStreamEnded = true;
		endIfAllDone();
	});

	inStream.on('error', err => {
		//console.log('inStream error:', err);
		failed(err);
		inStreamEnded = true;
		endIfAllDone();
	});

	// Child process handlers
	const stderrOutput = [];
	stderr.on('data', data => {
		//console.log('funzip stderr:', data.toString().trim());
		stderrOutput.push(data);
	});

	funzip.on('close', (code, signal) => {
		//console.log('funzip close:', {code, signal});
		if (childClosed) return;
		childClosed = true;

		if (code || signal || stderrOutput.length) {
			// funzip exited abnormally or wrote to stderr
			const stderrText = stderrOutput.join().trim(),
				err = new Error(`funzip exited with ${code ? `code ${code}` : `signal ${signal}`} and stderr output '${stderrText}'`);
			failed(err);
		}

		endIfAllDone();
	});

	funzip.on('error', err => {
		//console.log('funzip error:', err);
		// Called if child process could not be spawned
		childKilled = true;
		failed(err);
	});

	// stdout handler
	stdout.on('end', () => {
		//console.log('stdout end');
		stdoutEnded = true;
		endIfAllDone();
	});

	// Add destroy method to output stream
	outStream.destroy = () => {
		//console.log('outStream destroy');
		if (!errored) close();
	};

	// For debugging only - TODO remove this
	/*
	stdout.on('close', () => {
		console.log('stdout close');
	});

	inStream.on('close', () => {
		console.log('inStream close');
	});
	*/

	/*
	 * Send data to funzip
	 */
	// Construct ZIP file header
	const zip64 = entry.compressedSize >= FOUR_GIB || entry.uncompressedSize >= FOUR_GIB,
		extraFieldLength = zip64 ? 20 : 0;

	const header = Buffer.allocUnsafe(LFH_LENGTH + 1 + extraFieldLength);
	header.writeUInt32LE(LFH_SIGNATURE, 0);
	header.writeUInt16LE(entry.versionNeededToExtract, 4);
	header.writeUInt16LE(entry.generalPurposeBitFlag & ~8, 6); // jshint ignore:line
	header.writeUInt16LE(entry.compressionMethod, 8);
	header.writeUInt16LE(entry.lastModFileTime, 10);
	header.writeUInt16LE(entry.lastModFileDate, 12);
	header.writeUInt32LE(entry.crc32, 14);
	header.writeUInt32LE(zip64 ? FOUR_GIB - 1 : entry.compressedSize, 18);
	header.writeUInt32LE(zip64 ? FOUR_GIB - 1 : entry.uncompressedSize, 22);
	header.writeUInt16LE(1, 26); // Filename length
	header.writeUInt16LE(extraFieldLength, 28);
	header.writeUInt8(65, 30); // Filename
	if (zip64) {
		header.writeUInt16LE(0x0001, 31); // Zip64 extra field header
		header.writeUInt16LE(16, 33); // Zip64 extra field length
		writeUInt64LE(header, entry.uncompressedSize, 35);
		writeUInt64LE(header, entry.compressedSize, 43);
	}

	// Write header to funzip
	stdin.write(header);

	// Pipe stream to funzip
	//console.log('piping inStream to stdin');
	inStreamPiped = true;
	inStream.pipe(stdin);

	// Return outStream
	return outStream;
}

function writeUInt64LE(buffer, num, offset) {
	const lower = num % FOUR_GIB,
		upper = (num - lower) / FOUR_GIB;

	buffer.writeUInt32LE(lower, offset);
	buffer.writeUInt32LE(upper, offset + 4);
}
