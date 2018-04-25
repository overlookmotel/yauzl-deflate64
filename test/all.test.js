/* --------------------
 * yauzl-deflate64 module
 * Tests
 * ------------------*/

'use strict';

// Modules
const chai = require('chai'),
	{expect} = chai,
	pathJoin = require('path').join,
	yauzl = require('../lib/');

// Init
chai.config.includeStack = true;

// Tests

/* jshint expr: true */
/* global describe, it */

const PATH = pathJoin(__dirname, 'test.zip'),
	BYTES = 220;

it('Stream emits error if funzipPath invalid', function(cb) {
	testError({
		openOptions: {funzipPath: 'no-exist'},
		expectFn: err => {
			expect(err.code).to.equal('ENOENT');
		}
	}, cb);
});

it('Works normally', function(cb) {
	testSuccess(null, cb);
});

it('Stream emits error if CRC32 wrong', function(cb) {
	testError({
		injectFn: entry => entry.crc32++,
		expectFn: err => {
			expect(err.message).to.equal('funzip exited with code 4 and stderr output \'funzip error: invalid compressed data--crc error\'');
		}
	}, cb);
});

describe('Stream emits error if uncompressed size', function() {
	it('too big', function(cb) {
		testError({
			injectFn: entry => entry.uncompressedSize++,
			expectFn: err => {
				expect(err.message).to.equal('funzip exited with code 4 and stderr output \'funzip error: invalid compressed data--length error\'');
			}
		}, cb);
	});

	it('too small', function(cb) {
		testError({
			injectFn: entry => entry.uncompressedSize--,
			expectFn: err => {
				expect(err.message).to.equal('funzip exited with code 4 and stderr output \'funzip error: invalid compressed data--length error\'');
			}
		}, cb);
	});
});

/*
 * Helper functions
 */
function testSuccess(params, cb) {
	const {openOptions, streamOptions, injectFn} = params || {};

	getEntry(openOptions, (err, zipFile, entry) => {
		if (err) return cb(err);

		if (injectFn) injectFn(entry, zipFile);

		getStream(zipFile, entry, streamOptions, (err, stream) => {
			if (err) return cb(err);

			let bytesRead = 0;
			stream.on('data', chunk => bytesRead += chunk.length);

			stream.on('end', () => {
				expect(bytesRead).to.equal(BYTES);
				cb();
			});

			stream.on('error', cb);
		});
	});
}

function testError(params, cb) {
	const {openOptions, streamOptions, injectFn, expectFn} = params || {};

	getEntry(openOptions, (err, zipFile, entry) => {
		if (err) return cb(err);

		if (injectFn) injectFn(entry, zipFile);

		getStream(zipFile, entry, streamOptions, (err, stream) => {
			if (err) return cb(err);

			stream.on('data', () => {});

			stream.on('error', err => {
				expect(err).to.be.instanceof(Error);
				if (expectFn) {
					try {
						expectFn(err, entry, zipFile);
					} catch (err) {
						return cb(err);
					}
				}

				cb();
			});

			stream.on('end', () => cb(new Error('end event emitted')));
		});
	});
}

function getEntry(options, cb) {
	options = Object.assign({autoClose: false, lazyEntries: true, funzip: true}, options);

	yauzl.open(PATH, options, (err, zipFile) => {
		if (err) return cb(err);

		zipFile.on('error', cb);

		zipFile.on('entry', entry => {
			cb(null, zipFile, entry);
		});

		zipFile.readEntry();
	});
}

function getStream(zipFile, entry, options, cb) {
	options = Object.assign({decompress: true}, options);
	zipFile.openReadStream(entry, {decompress: true}, (err, stream) => {
		if (err) return cb(err);
		cb(null, stream);
	});
}
