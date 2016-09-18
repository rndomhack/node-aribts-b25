"use strict";

const fs = require("fs");
const stream = require("stream");
const aribts = require("aribts");
const TsB25Decoder = require("../index").TsB25Decoder;

const startTime = Date.now();
const size = process.argv[2] === "-" ? 0 : fs.statSync(process.argv[2]).size;
let bytesRead = 0;

const readableStream = process.argv[2] === "-" ? process.stdin : fs.createReadStream(process.argv[2]);
const writableStream = process.argv[3] === "-" ? process.stdout : fs.createWriteStream(process.argv[3]);
const transformStream = new stream.Transform({
    transform: function (chunk, encoding, done) {
        bytesRead += chunk.length;

        process.stderr.write("\r\u001b[K");
        process.stderr.write(`Decode - ${bytesRead} of ${size} [${Math.floor(bytesRead / size * 100)}%]`);

        this.push(chunk);
        done();
    },
    flush: function (done) {
        process.stderr.write("\r\u001b[K");
        process.stderr.write(`Done - ${bytesRead} of ${size} [${Math.floor(bytesRead / size * 100)}%]\n`);
        process.stderr.write(`time: ${(Date.now() - startTime) / 1000} s`);

        done();
    }
});

const tsReadableConnector = new aribts.TsReadableConnector();
const tsWritableConnector = new aribts.TsWritableConnector();
const tsPacketParser = new aribts.TsPacketParser();
const tsPacketConverter = new aribts.TsPacketConverter();
const tsSectionParser = new aribts.TsSectionParser();
const tsB25Decoder = new TsB25Decoder();

tsB25Decoder.start().then(() => {
    readableStream.pipe(transformStream);
    transformStream.pipe(tsReadableConnector);
    tsWritableConnector.pipe(writableStream);

    tsSectionParser.on("pmt", tsB25Decoder.onPmt.bind(tsB25Decoder));
    tsSectionParser.on("ecm", tsB25Decoder.onEcm.bind(tsB25Decoder));

    tsReadableConnector.pipe(tsPacketParser);
    tsPacketParser.pipe(tsSectionParser);
    tsPacketParser.pipe(tsB25Decoder);
    tsB25Decoder.pipe(tsPacketConverter);
    tsPacketConverter.pipe(tsWritableConnector);

    writableStream.on("finish", () => {
        tsB25Decoder.stop();
    });
}).catch(err => {
    console.error(err);

    tsB25Decoder.stop();
});
