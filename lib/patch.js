/* --------------------
 * yauzl-defalte64 module
 * Patch `.openReadStream()` method to add Defalte64 unzip capability
 * ------------------*/

'use strict';

// Modules
const {spawn} = require('child_process'),
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
			// Conform options
			let {funzip, funzipPath} = options;
			if (!funzip) {
				funzip = [];
			} else if (funzip == true) {
				funzip = COMPRESS_ALL;
			} else if (!Array.isArray(funzip)) {
				funzip = [funzip];
			}
			funzipPath = funzipPath ? funzipPath + '' : 'funzip';

			// Call original function
			original.call(this, path, totalSize, options, (err, zipFile) => {
				if (err) return cb(err);

				zipFile.funzip = funzip;
				zipFile.funzipPath = funzipPath;
				cb(null, zipFile);
			});
		};
	});

	// Patch `openReadStream` method to use Deflate64
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
		const {decompress} = options;
		let funzip = false;
		if (
			this.funzip.indexOf(entry.compressionMethod) != -1 &&
			(decompress == null || decompress) &&
			options.start == null && options.end == null
		) {
			funzip = true;
			options = Object.assign({}, options, {decompress: false});
			// TODO Find better way to prevent decompression than altering options
		}

		// Open read stream
		openReadStream.call(this, entry, options, (err, stream) => {
			// Restore original value of `options.decompress`
			if (funzip) options.decompress = decompress;

			// Exit if error
			if (err) return cb(err);

			// If not using funzip, callback with stream unchanged
			if (!funzip) return cb(null, stream);

			// Pipe through funzip
			const funzipStream = makeFunzipStream(stream, entry, this.funzipPath);
			stream.on('error', err => funzipStream.emit('error', err));

			// Add `destroy` method which calls `.destroy()` on previous stream
			let destroyed = false;
			funzipStream.destroy = function() {
				if (destroyed) return;
				destroyed = true;
				stream.unpipe(funzipStream);
				stream.destroy();
			};

			// If validateEntrySizes option set, chain stream to validate entry sizes
			// TODO Investigate if funzip already validates size + if not then write this

			// Callback with new stream
			cb(null, funzipStream);
		});
	};

	// Return yauzl object
	return yauzl;
};

/*
 * DeflateStream
 */
function makeFunzipStream(stream, entry, funzipPath) {
	// Spawn funzip
	const funzip = spawn(funzipPath);
	const {stdin, stdout, stderr} = funzip;

	// Error handler
	funzip.on('error', err => stdout.emit('error', err));

	funzip.on('exit', code => {
		if (code) stdout.emit(new Error(`funzip exited with code ${code}`));
	});

	stderr.on('data', data => stdout.emit('error', new Error(`Unexpected funzip stderr output: ${data}`)));

	// Construct zip file header
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
	stream.pipe(stdin);

	// Return funzip stdout stream
	return funzip.stdout;
}

function writeUInt64LE(buffer, num, offset) {
	const lower = num % FOUR_GIB,
		upper = (num - lower) / FOUR_GIB;

	buffer.writeUInt32LE(lower, offset);
	buffer.writeUInt32LE(upper, offset + 4);
}
