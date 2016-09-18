"use strict";

const aribts = require("aribts");
const Multi2 = require("multi2");
const TsUtil = aribts.TsUtil;
const TsBase = aribts.TsBase;
const TsB25CasCard = require("../lib/b25_cas_card");

class TsB25Decoder extends TsBase {
    constructor(options) {
        super();

        this._options = Object.assign({
            readerName: "",
            processEmm: false,
            outputScramblingPacket: false
        }, options || {});

        this._versions = {};

        this._programs = {};

        this._ess = {};
        this._ecms = {};
        this._emms = {};

        this._casCard = null;
        this._initialSetting = null;
    }

    _process(tsPacket, callback) {
        const pid = tsPacket.getPid();
        const transportScramblingControl = tsPacket.getTransportScramblingControl();

        if ((transportScramblingControl >> 1) === 0) {
            this.push(tsPacket);

            callback();
            return;
        }

        if (!this._ess.hasOwnProperty(pid)) {
            if (this._options.outputScramblingPacket) {
                this.push(tsPacket);
            }

            callback();
            return;
        }

        const ecm = this._ess[pid];

        if (ecm.promise !== null && ecm.lastKs !== transportScramblingControl) {
            ecm.callback = () => {
                ecm.callback = null;

                this._process(tsPacket, callback);
            };

            return;
        }

        if (!ecm.ready) {
            if (this._options.outputScramblingPacket) {
                this.push(tsPacket);
            }

            callback();
            return;
        }

        const buffer = tsPacket.getBuffer();
        const data = tsPacket.getData();

        ecm.multi2.decrypt(data, (transportScramblingControl & 1) === 0);
        buffer[3] = buffer[3] & 0x3F;

        this.push(tsPacket);

        callback();
    }

    _flush(callback) {
        callback();
    }

    start() {
        if (this._casCard !== null) return Promise.resolve();

        const casCard = new TsB25CasCard();

        this._casCard = casCard;

        return casCard.start().then(() => {
            const readers = casCard.getReaders();
            let reader = null;

            for (let i = 0, l = readers.length; i < l; i++) {
                if (!readers[i].name.includes(this._options.readerName)) continue;

                reader = readers[i];
                break;
            }

            if (reader === null) {
                throw new Error("Can't find smartcard reader");
            }

            casCard.setReader(reader);

            return casCard.open();
        }).then(() => {
            return casCard.sendInitialSetting();
        }).then(initialSetting => {
            this._initialSetting = initialSetting;
        });
    }

    stop() {
        if (this._casCard === null) return Promise.resolve();

        const casCard = this._casCard;

        this._casCard = null;

        return casCard.close().then(() => {
            return casCard.stop();
        });
    }

    onPmt(tsSection) {
        const subTable = TsUtil.getNestedObject(this._versions, [tsSection.getTableId(), tsSection.getProgramNumber()]);
        const isUpdated = TsUtil.updateSubTable(subTable, tsSection);

        if (!TsUtil.updateSection(subTable, tsSection)) return;

        const objSection = tsSection.decode();

        const program = TsUtil.getNestedObject(this._programs, [objSection.program_number]);

        if (isUpdated) {
            program.ecmPid = -1;
            program.esPids = [];
            program.flag = false;
        }

        const tsDescriptors = objSection.program_info.decode();

        for (let i = 0, l = tsDescriptors.length; i < l; i++) {
            const tsDescriptor = tsDescriptors[i];

            switch (tsDescriptor.getDescriptorTag()) {
                case 0x09: {
                    // Conditional access
                    const objDescriptor = tsDescriptor.decode();

                    if (objDescriptor.CA_system_ID !== this._initialSetting.caSystemId) break;

                    program.ecmPid = objDescriptor.CA_PID;

                    break;
                }
            }
        }

        for (let i = 0, l = objSection.streams.length; i < l; i++) {
            const stream = objSection.streams[i];

            program.esPids.push(stream.elementary_PID);
        }

        if (TsUtil.checkSections(subTable)) {
            program.flag = true;

            this._updatePmt();
        }
    }

    onEcm(tsSection) {
        const pid = tsSection.getPid();

        if (!TsUtil.checkNestedObject(this._ecms, [pid])) return;

        const subTable = TsUtil.getNestedObject(this._versions, [tsSection.getTableId(), pid]);

        TsUtil.updateSubTable(subTable, tsSection);

        if (!TsUtil.updateSection(subTable, tsSection)) return;

        const ecm = TsUtil.getNestedObject(this._ecms, [pid]);
        const ecmPayload = tsSection.getEcmPayload();

        const promise = this._casCard.sendEcmPayload(ecmPayload).then(ecmResponse => {
            if (promise !== ecm.promise) return;

            ecm.promise = null;

            if (![0x0200, 0x0400, 0x0800, 0x4480, 0x4280].includes(ecmResponse.returnCode)) return;

            const odd = ecmResponse.ks.slice(0, 8);
            const even = ecmResponse.ks.slice(8, 16);

            ecm.ready = true;
            ecm.lastKs = 0;

            if (ecm.lastOdd !== null && Buffer.compare(ecm.lastOdd, odd) !== 0) {
                ecm.lastKs += 3;
            }

            if (ecm.lastEven !== null && Buffer.compare(ecm.lastEven, even) !== 0) {
                ecm.lastKs += 2;
            }

            ecm.lastOdd = odd;
            ecm.lastEven = even;

            ecm.multi2.setScrambleKey(ecmResponse.ks);

            if (ecm.callback !== null) {
                ecm.callback();
            }
        }).catch(() => {
            if (promise !== ecm.promise) return;

            ecm.promise = null;

            ecm.ready = false;
            ecm.lastKs = 0;
            ecm.lastOdd = null;
            ecm.lastEven = null;

            if (ecm.callback !== null) {
                ecm.callback();
            }
        });

        ecm.promise = promise;
    }

    _updatePmt() {
        const ess = {};
        const ecms = {};

        // PMT
        for (let keys = Object.keys(this._programs), i = 0, l = keys.length; i < l; i++) {
            const program = this._programs[keys[i]];

            if (!program.flag) continue;
            if (!program.ecmPid === -1) continue;

            const ecm = TsUtil.getNestedObject(this._ecms, [program.ecmPid]);

            if (Object.keys(ecm).length === 0) {
                const multi2 = new Multi2();

                multi2.setRound(4);
                multi2.setSystemKey(this._initialSetting.descramblingSystemKey);
                multi2.setInitialCbc(this._initialSetting.descramblerCbcInitialValue);

                ecm.ready = false;
                ecm.lastKs = 0;
                ecm.lastOdd = null;
                ecm.lastEven = null;
                ecm.promise = null;
                ecm.callback = null;
                ecm.multi2 = multi2;
            }

            for (let j = 0, l2 = program.esPids.length; j < l2; j++) {
                ess[program.esPids[j]] = ecm;
            }

            ecms[program.ecmPid] = ecm;
        }

        this._ess = ess;
        this._ecms = ecms;
    }
}

module.exports = TsB25Decoder;
