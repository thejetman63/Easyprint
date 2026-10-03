// Talks to the printer over USB, the same way Pronterface does:
// sends G-code one line at a time, waits for "ok", resends if the printer asks,
// and reads temperatures.

const fs = require('fs');
const { EventEmitter } = require('events');

const BAUD = 115200;
// USB chips used by Creality boards (CH340, CP210x, FTDI, STM32 virtual COM)
const KNOWN_VENDORS = ['1a86', '10c4', '0403', '0483', '2341'];

class Printer extends EventEmitter {
  constructor({ openTransport, listPorts }) {
    super();
    this.openTransport = openTransport; // (path) => Promise<transport>
    this.listPorts = listPorts;         // () => Promise<[{path, vendorId, manufacturer}]>
    this.reset();
  }

  reset() {
    this.port = null;
    this.portPath = null;
    this.connected = false;
    this.buffer = '';
    this.temps = { nozzle: null, nozzleTarget: null, bed: null, bedTarget: null };
    this.job = null;          // the print in progress
    this.waitingOk = false;   // a line is out and we're waiting for "ok"
    this.manualQueue = [];    // lines we send ourselves (cooldown, pause moves...)
    this.lineNo = 0;
    this.sent = new Map();    // line number -> text, for resends
  }

  // ---------- connecting ----------

  async findPort() {
    const ports = await this.listPorts();
    const score = (p) => (KNOWN_VENDORS.includes(String(p.vendorId || '').toLowerCase()) ? 2 : 0)
      + (/ch340|silicon|ftdi|usb|serial|creality/i.test(`${p.manufacturer} ${p.friendlyName}`) ? 1 : 0);
    return ports.sort((a, b) => score(b) - score(a))[0]?.path || null;
  }

  async connect(path) {
    if (this.connected) return this.status();
    const target = path || await this.findPort();
    if (!target) throw new Error('No printer found. Check the USB cable and that the printer is turned on.');
    let port;
    try {
      port = await this.openTransport(target, BAUD);
    } catch (e) {
      if (/access|denied|busy|in use/i.test(e.message)) {
        throw new Error('The printer is being used by another program. Close Pronterface or OrcaSlicer and try again.');
      }
      throw new Error(`Couldn\u2019t connect to the printer (${e.message}).`);
    }
    this.reset();
    this.port = port;
    this.portPath = target;
    port.on('data', (d) => this.onData(d.toString()));
    port.on('close', () => this.onClosed());
    port.on('error', (e) => this.emit('log', `error: ${e.message}`));

    // Most boards restart when the USB connection opens. Wait for it to say hello.
    await this.waitForGreeting(4000);
    this.connected = true;
    this.lineNo = 0;
    this.sendNow('M110 N0');      // start line numbering from zero
    this.sendNow('M155 S2');      // report temperatures every 2 seconds
    this.emitStatus();
    return this.status();
  }

  waitForGreeting(ms) {
    return new Promise((resolve) => {
      const done = () => { clearTimeout(t); this.off('line', onLine); resolve(); };
      const onLine = (l) => { if (/^start|^ok|marlin|echo:/i.test(l)) setTimeout(done, 300); };
      const t = setTimeout(done, ms);
      this.on('line', onLine);
    });
  }

  async disconnect() {
    if (this.job && !this.job.finished) throw new Error('Stop the print before disconnecting.');
    const p = this.port;
    this.reset();
    if (p) await new Promise((r) => p.close(() => r()));
    this.emitStatus();
  }

  onClosed() {
    const wasPrinting = this.job && !this.job.finished;
    this.reset();
    this.emitStatus();
    if (wasPrinting) this.emit('problem', 'The printer was disconnected during the print. Check the USB cable.');
  }

  // ---------- talking ----------

  write(raw) {
    this.port?.write(raw + '\n');
    this.emit('log', `> ${raw}`);
  }

  // every line gets a number and checksum so the printer can spot garbled lines
  numbered(text) {
    this.lineNo += 1;
    const body = `N${this.lineNo} ${text}`;
    let cs = 0;
    for (let i = 0; i < body.length; i++) cs ^= body.charCodeAt(i);
    this.sent.set(this.lineNo, text);
    if (this.sent.size > 200) this.sent.delete(this.lineNo - 200);
    return `${body}*${cs}`;
  }

  sendNow(text) {
    this.manualQueue.push(text);
    this.pump();
  }

  // send the next line if the printer is ready for one
  pump() {
    if (!this.port || this.waitingOk) return;
    let text = this.manualQueue.shift();
    if (text === undefined && this.job && !this.job.paused && !this.job.finished) {
      text = this.nextJobLine();
      if (text === undefined) return this.finishJob();
    }
    if (text === undefined) return;
    this.waitingOk = true;
    this.lastSendAt = Date.now();
    if (/^M110\b/.test(text)) {
      // resets the printer's line counter; sent without a number
      this.lineNo = parseInt((text.match(/N(-?\d+)/) || [0, 0])[1], 10);
      this.sent.clear();
      this.write(text);
    } else {
      this.write(this.numbered(text));
    }
  }

  onData(chunk) {
    this.buffer += chunk;
    let i;
    while ((i = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, i).trim();
      this.buffer = this.buffer.slice(i + 1);
      if (line) this.onLine(line);
    }
  }

  onLine(line) {
    this.emit('line', line);
    if (!/^ok$/i.test(line) && !/T:\s*-?[\d.]/.test(line)) this.emit('log', `< ${line}`);

    if (/T:\s*-?[\d.]+/.test(line)) this.readTemps(line);

    const resend = line.match(/^(?:resend|rs)[: ]\s*N?:?(\d+)/i);
    if (resend) {
      // printer missed a line: go back to it
      const n = parseInt(resend[1], 10);
      this.resendFrom = n;
      return;
    }
    if (/^ok\b/i.test(line)) {
      if (this.resendFrom != null) {
        const n = this.resendFrom;
        this.resendFrom = null;
        const text = this.sent.get(n);
        if (text !== undefined) {
          this.lineNo = n - 1;
          // put back everything from n onward
          const back = [];
          for (let k = n; this.sent.has(k); k++) back.push(this.sent.get(k));
          this.manualQueue.unshift(...back.slice(1));
          this.waitingOk = true;
          this.write(this.numbered(back[0]));
          return;
        }
      }
      this.waitingOk = false;
      this.pump();
      return;
    }
    if (/^error/i.test(line) && /kill|halt|stopped|thermal|MINTEMP|MAXTEMP/i.test(line)) {
      if (this.job) { this.job.finished = true; this.job.failed = true; }
      this.emit('problem', `The printer stopped itself: ${line.replace(/^error:?/i, '').trim()}`);
      this.emitStatus();
    }
  }

  readTemps(line) {
    const t = line.match(/T:\s*(-?[\d.]+)\s*\/\s*(-?[\d.]+)/);
    const b = line.match(/B:\s*(-?[\d.]+)\s*\/\s*(-?[\d.]+)/);
    if (t) { this.temps.nozzle = +t[1]; this.temps.nozzleTarget = +t[2]; }
    if (b) { this.temps.bed = +b[1]; this.temps.bedTarget = +b[2]; }
    this.emitStatus();
  }

  // ---------- printing ----------

  startPrint(gcodePath, { estimateSeconds } = {}) {
    if (!this.connected) throw new Error('Connect to the printer first.');
    if (this.job && !this.job.finished) throw new Error('A print is already running.');
    const lines = fs.readFileSync(gcodePath, 'utf8').split(/\r?\n/)
      .map((l) => l.replace(/;.*$/, '').trim())
      .filter(Boolean);
    const relativeE = lines.some((l) => /^M83\b/.test(l));
    this.job = {
      lines, index: 0, startedAt: Date.now(), pausedMs: 0, pausedAt: null,
      estimateSeconds: estimateSeconds || null, paused: false, finished: false, relativeE,
      file: gcodePath,
    };
    this.emit('log', `--- printing ${lines.length} lines ---`);
    this.emitStatus();
    this.pump();
  }

  nextJobLine() {
    const j = this.job;
    while (j.index < j.lines.length) {
      const l = j.lines[j.index++];
      if (/^M110\b/.test(l)) continue; // we manage line numbers ourselves
      if (j.index % 50 === 0) this.emitStatus();
      return l;
    }
    return undefined;
  }

  finishJob() {
    if (!this.job || this.job.finished) return;
    this.job.finished = true;
    this.job.finishedAt = Date.now();
    this.emitStatus();
    this.emit('done');
  }

  pause() {
    const j = this.job;
    if (!j || j.finished || j.paused) return;
    j.paused = true;
    j.pausedAt = Date.now();
    // lift the nozzle and pull the filament back a little so it doesn't ooze or melt the print
    this.sendNow('M400');
    this.sendNow('G91');
    this.sendNow('G1 E-2 F1800');
    this.sendNow('G1 Z5 F600');
    this.sendNow('G90');
    if (j.relativeE) this.sendNow('M83');
    this.emitStatus();
  }

  resume() {
    const j = this.job;
    if (!j || !j.paused) return;
    this.sendNow('G91');
    this.sendNow('G1 Z-5 F600');
    this.sendNow('G1 E2 F1800');
    this.sendNow('G90');
    if (j.relativeE) this.sendNow('M83');
    j.pausedMs += Date.now() - j.pausedAt;
    j.pausedAt = null;
    j.paused = false;
    this.emitStatus();
    this.pump();
  }

  stop() {
    const j = this.job;
    if (!j || j.finished) return;
    j.finished = true;
    j.stopped = true;
    this.manualQueue = [];
    // turn heaters and fan off, move the nozzle up and out of the way
    for (const l of ['M104 S0', 'M140 S0', 'M107', 'G91', 'G1 Z10 F600', 'G90', 'G28 X', 'M84']) this.sendNow(l);
    this.emitStatus();
  }

  // ---------- status for the window ----------

  status() {
    const j = this.job;
    let job = null;
    if (j) {
      const progress = j.lines.length ? j.index / j.lines.length : 0;
      const elapsed = ((j.finishedAt || Date.now()) - j.startedAt - j.pausedMs - (j.pausedAt ? Date.now() - j.pausedAt : 0)) / 1000;
      let left = null;
      if (!j.finished) {
        if (progress > 0.05) left = elapsed / progress - elapsed;
        else if (j.estimateSeconds) left = j.estimateSeconds - elapsed;
        if (left != null && j.estimateSeconds && progress <= 0.3) {
          // early on, lean on Orca's estimate (heating skews the start)
          left = (j.estimateSeconds * (1 - progress)) * (1 - progress / 0.3) + left * (progress / 0.3);
        }
      }
      job = {
        progress, elapsed, left: left != null ? Math.max(0, left) : null,
        paused: j.paused, finished: j.finished, stopped: !!j.stopped, failed: !!j.failed,
      };
    }
    return { connected: this.connected, port: this.portPath, temps: this.temps, job };
  }

  emitStatus() { this.emit('status', this.status()); }
}

module.exports = { Printer, BAUD };
