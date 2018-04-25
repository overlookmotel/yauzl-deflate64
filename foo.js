'use strict';

const fs = require('fs');
const pathJoin = require('path').join;
const yauzl = require('./lib/');

const path = pathJoin(__dirname, 'test/test.zip');
//const path = pathJoin(__dirname, 'unzipped with funzip.mov.zip');
//const path = '/Cinebox/downloads/01660/unzipped/walkin%20the%20dog%20wip10b%20%28festival%20cut%29%201080%20dnxhd.zip';
const pathOut = pathJoin(__dirname, 'out.mov');

doIt((err, bytesRead) => {
	if (err) return console.log('ERROR:', err.stack);
	console.log('DONE');
	console.log('bytesRead:', bytesRead);
});

function doIt(cb) {
	yauzl.open(path, {funzip: true, autoClose: false, lazyEntries: true}, (err, zipFile) => {
		if (err) return cb(err);

		console.log('zipFile:', zipFile);

		zipFile.on('error', cb);

		zipFile.on('entry', entry => {
			console.log('entry:', entry);
			console.log('entry.compressionMethod:', entry.compressionMethod);

			process.exit();

			zipFile.openReadStream(entry, {decompress: true}, (err, stream) => {
				if (err) return cb(err);

				const streamOut = fs.createWriteStream(pathOut);

				let streamErr;
				stream.on('error', err => {
					console.log('yauzl stream error:', err);
					streamErr = err;
				});
				streamOut.on('error', err => {
					console.log('out stream error:', err);
					streamErr = err;
					cb(err);
					stream.destroy();
				});
				streamOut.on('close', () => {
					console.log('out stream close');
					cb(streamErr);
				});

				stream.pipe(streamOut);

				/*
				let bytesRead = 0;
				//const chunks = [];
				stream.on('data', chunk => {
					//chunks.push(chunk);
					bytesRead += chunk.length;
				});
				stream.on('error', cb);
				stream.on('end', () => {
					//const data = Buffer.concat(chunks);
					//console.log(data.toString());
					cb(null, bytesRead);
				});
				*/
			});
		});

		zipFile.readEntry();
	});
}
