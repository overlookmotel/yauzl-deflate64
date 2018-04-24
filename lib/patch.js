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
	LFH_SIGNATURE = 0x04034b50;

// Exports
module.exports = function(yauzl) {
	// Patch access methods to store `deflate64` + `funzipPath` options
	cloner.patchAll(yauzl, original => {
		return (path, totalSize, options, cb) => {
			original(path, totalSize, options, (err, zipFile) => {
				if (err) return cb(err);
				zipFile.deflate64 = !!options.deflate64;
                zipFile.funzipPath = options.funzipPath ? options.funzipPath + '' : 'funzip';
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
		}
        options = Object.assign({}, options);

		// Work out if should use deflate64
        const {decompress} = options;
		let deflate = false;
        if (
            this.deflate64 &&
            entry.compressionMethod == 8 && // TODO change back to 9
			(decompress == null || decompress) &&
            options.start == null && options.end == null
        ) {
            deflate = true;
            options.decompress = false;
        }

		// Open read stream
		openReadStream.call(this, entry, options, (err, stream) => {
            options.decompress = decompress;

			if (err) return cb(err);

			// If not deflating, callback with stream
			if (!deflate) return cb(null, stream);

            // Pipe through funzip
            const deflateStream = makeDeflateStream(stream, entry, this.funzipPath);

			stream.on('error', err => deflateStream.emit('error', err));

			// Add `destroy` method which calls `.destroy()` on previous stream
			let destroyed = false;
			deflateStream.destroy = function() {
				if (destroyed) return;
				destroyed = true;
				stream.unpipe(deflateStream);
				stream.destroy();
			};

			// Callback with new stream
			cb(null, deflateStream);
		});
	};

	// Return yauzl object
	return yauzl;
};

/*
 * DeflateStream
 */
function makeDeflateStream(stream, entry, funzipPath) {
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
