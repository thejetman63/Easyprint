// A pretend Marlin printer for testing without real hardware.
// Start the app with EASYPRINT_FAKE_PRINTER=1 to use it.

const { EventEmitter } = require('events');

class FakeMarlin extends EventEmitter {
  constructor({ speed = 1, corruptEvery = 0 } = {}) {
    super();
    this.speed = speed;            // ms per line
    this.corruptEvery = corruptEvery; // simulate a garbled line now and then
    this.expected = 1;
    this.count = 0;
    this.nozzle = 24; this.nozzleT = 0; this.bed = 23; this.bedT = 0;
    this.received = [];
    this.timer = null;
    this.open = true;
    setTimeout(() => this.say('start\necho:Marlin 2.1.2'), 50);
    this.heat = setInterval(() => {
      this.nozzle += (this.nozzleT - this.nozzle) * 0.3;
      this.bed += (this.bedT - this.bed) * 0.3;
      if (this.autoReport) this.say(this.tempLine());
    }, 200);
  }

  tempLine() {
    return `T:${this.nozzle.toFixed(1)} /${this.nozzleT.toFixed(1)} B:${this.bed.toFixed(1)} /${this.bedT.toFixed(1)} @:0 B@:0`;
  }

  say(text) { if (this.open) setTimeout(() => this.emit('data', Buffer.from(text + '\n')), 1); }

  write(raw) {
    for (const line of raw.split('\n').filter(Boolean)) this.handle(line.trim());
  }

  handle(line) {
    const m = line.match(/^N(\d+) (.*)\*(\d+)$/);
    let cmd = line;
    if (m) {
      const n = +m[1];
      this.count++;
      if (this.corruptEvery && this.count % this.corruptEvery === 0) {
        this.say(`Error:checksum mismatch, Last Line: ${this.expected - 1}\nResend: ${n}\nok`);
        return;
      }
      if (n !== this.expected) {
        this.say(`Error:Line Number is not Last Line Number+1, Last Line: ${this.expected - 1}\nResend: ${this.expected}\nok`);
        return;
      }
      this.expected = n + 1;
      cmd = m[2];
    } else if (/^M110/.test(line)) {
      this.expected = parseInt((line.match(/N(-?\d+)/) || [0, 0])[1], 10) + 1;
    }
    this.received.push(cmd);
    const g = cmd.split(' ')[0];
    if (g === 'M104' || g === 'M109') this.nozzleT = +(cmd.match(/S([\d.]+)/) || [0, 0])[1];
    if (g === 'M140' || g === 'M190') this.bedT = +(cmd.match(/S([\d.]+)/) || [0, 0])[1];
    if (g === 'M155') this.autoReport = !/S0\b/.test(cmd);
    if (g === 'M105') return this.say(`ok ${this.tempLine()}`);
    setTimeout(() => this.say('ok'), this.speed);
  }

  close(cb) { this.open = false; clearInterval(this.heat); this.emit('close'); cb?.(); }
}

module.exports = { FakeMarlin };
