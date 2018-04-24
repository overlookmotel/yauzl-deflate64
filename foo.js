'use strict';

const pathJoin = require('path').join;
const yauzl = require('./lib/');

const path = pathJoin(__dirname, '../yauzl-mac/test files/test.zip');

doIt((err, bytesRead) => {
    if (err) throw err;
    console.log('bytesRead:', bytesRead);
});

function doIt(cb) {
    yauzl.open(path, {deflate64: true, autoClose: false, lazyEntries: true}, (err, zipFile) => {
        if (err) return cb(err);

        zipFile.on('error', cb);

        zipFile.on('entry', entry => {
            console.log('entry:', entry);

            zipFile.openReadStream(entry, (err, stream) => {
                if (err) return cb(err);

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
            });
        });

        zipFile.readEntry();
    });
}
