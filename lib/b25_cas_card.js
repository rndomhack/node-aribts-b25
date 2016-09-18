"use strict";

const pcsclite = require("pcsclite");

let pcsc = null;
let pcscCount = 0;
let readers = null;

class TsB25CasCard {
    constructor() {
        this._pcsc = null;
        this._reader = null;
    }

    start() {
        return new Promise(resolve => {
            if (this._pcsc !== null) return;

            if (pcscCount++ !== 0) {
                this._pcsc = pcsc;
                return;
            }

            // Init PCSCLite
            pcsc = pcsclite();
            readers = [];

            pcsc.on("error", () => {
                // Close PCSCLite
                pcsc.close();

                // Reset readers
                readers = [];

                // Start PCSCLite
                pcsc = pcsclite();
            });

            pcsc.on("reader", reader => {
                reader.on("error", () => {
                    // Nothing
                });

                reader.on("end", () => {
                    if (readers === null) return;
                    if (!readers.includes(reader)) return;

                    // Remove reader
                    readers.splice(readers.indexOf(reader), 1);
                });

                // Add reader
                readers.push(reader);

                resolve();
            });

            this._pcsc = pcsc;

            setTimeout(resolve, 100);
        });
    }

    stop() {
        return new Promise(resolve => {
            if (this._pcsc === null) return;

            if (--pcscCount !== 0) {
                this._pcsc = null;
                return;
            }

            // Close PCSCLite
            pcsc.close();

            this._pcsc = null;

            pcsc = null;
            readers = null;

            resolve();
        });
    }

    open() {
        return this.close().then(() => {
            return new Promise((resolve, reject) => {
                this._reader.connect({
                    share_mode : this._reader.SCARD_SHARE_SHARED,
                    protocol : this._reader.SCARD_PROTOCOL_T1
                }, (err, protocol) => {
                    if (err) {
                        reject(err);
                        return;
                    }

                    if (protocol !== this._reader.SCARD_PROTOCOL_T1) {
                        this._reader.disconnect(this._reader.SCARD_LEAVE_CARD, () => {
                            reject(new Error("Protocol is not SCARD_PROTOCOL_T1"));
                        });
                        return;
                    }

                    resolve();
                });
            });
        });
    }

    close() {
        return new Promise(resolve => {
            if (this._reader === null) {
                resolve();
                return;
            }

            if (!this._reader.connected) {
                resolve();
                return;
            }

            this._reader.disconnect(this._reader.SCARD_LEAVE_CARD, () => {
                resolve();
            });
        });
    }

    transmit(input, resLen) {
        return new Promise((resolve, reject) => {
            this._reader.transmit(input, resLen, this._reader.SCARD_PROTOCOL_T1, (err, buffer) => {
                if (err) {
                    reject(err);
                    return;
                }

                resolve(buffer);
            });
        });
    }

    sendInitialSetting() {
        const header = Buffer.from([0x90, 0x30, 0x00, 0x00]);
        const le = Buffer.from([0x00]);
        const command = Buffer.concat([header, le]);

        return this.transmit(command, 1024).then(buffer => {
            if (buffer.length < 57) {
                throw new Error("Invalid initial setting response");
            }

            const initialSetting = {
                returnCode: (buffer[4] << 8) | buffer[5],
                caSystemId: (buffer[6] << 8) | buffer[7],
                cardId: buffer.slice(8, 14),
                cardType: buffer[14],
                messagePartitionLength: buffer[15],
                descramblingSystemKey: buffer.slice(16, 48),
                descramblerCbcInitialValue: buffer.slice(48, 56)
            };

            return initialSetting;
        });
    }

    sendEcmPayload(ecmPayload) {
        if (ecmPayload.length < 30 || ecmPayload.length > 256) {
            return Promise.reject(new Error("Invalid ecmPayload length"));
        }

        const header = Buffer.from([0x90, 0x34, 0x00, 0x00]);
        const lc = Buffer.from([ecmPayload.length]);
        const le = Buffer.from([0x00]);
        const command = Buffer.concat([header, lc, ecmPayload, le]);

        return this.transmit(command, 1024).then(buffer => {
            if (buffer.length !== 25) {
                throw new Error("Invalid ecm response");
            }

            const ecmResponse = {
                returnCode: (buffer[4] << 8) | buffer[5],
                ks: buffer.slice(6, 22),
                recordingControl: buffer[22]
            };

            return ecmResponse;
        });
    }

    getReaders() {
        return readers;
    }

    setReader(reader) {
        this._reader = reader;
    }
}

module.exports = TsB25CasCard;
