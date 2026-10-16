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
    this.zOffset = -2.07;
    this.pos = { x: 0, y: 0, z: 0 }; this.homed = false; this.relative = false;
    // a bed tilted up at the back-right
    this.mesh = Array.from({ length: 5 }, (_, j) => Array.from({ length: 5 }, (_, i) => -0.25 + i * 0.065 + j * 0.06));
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
    if (g === 'G28') { this.homed = true; this.pos = { x: 0, y: 0, z: 5 }; }
    if (g === 'G90') this.relative = false;
    if (g === 'G91') this.relative = true;
    if (g === 'G92') { for (const a of ['X', 'Y', 'Z']) { const v = cmd.match(new RegExp(a + '(-?[\\d.]+)')); if (v) { this.pos[a.toLowerCase()] = +v[1]; this.known = true; } } }
    if (g === 'M114') return this.say(`X:${this.pos.x.toFixed(2)} Y:${this.pos.y.toFixed(2)} Z:${this.pos.z.toFixed(2)} E:0.00 Count X:0 Y:0 Z:0\nok`);
    if ((g === 'G1' || g === 'G0') && /[XYZ]/.test(cmd)) {
      if (!this.homed && !this.known) return this.say('echo:Home XYZ First\nok');
      for (const a of ['X', 'Y', 'Z']) {
        const v = cmd.match(new RegExp(a + '(-?[\\d.]+)'));
        if (v) { const k = a.toLowerCase(); this.pos[k] = this.relative ? this.pos[k] + +v[1] : +v[1]; }
      }
      this.pos.z = Math.min(250, Math.max(0, this.pos.z));
    }
    if (g === 'M115') return this.say('FIRMWARE_NAME:Marlin Ender-3 V3 SE (fake) SOURCE_CODE_URL:github.com/CrealityOfficial MACHINE_TYPE:Ender-3 V3 SE\nCap:EEPROM:1\nCap:Z_PROBE:1\nok');
    if (g === 'M851') {
      const z = cmd.match(/Z(-?[\d.]+)/);
      if (z) { this.zOffset = parseFloat(z[1]); return setTimeout(() => this.say('ok'), this.speed); }
      return this.say(`echo:Probe Offset X-31.80 Y-40.50 Z${this.zOffset.toFixed(2)}\nok`);
    }
    if (g === 'M503') return this.say(`echo:; Z-Probe Offset (mm):\necho:  M851 X-31.80 Y-40.50 Z${this.zOffset.toFixed(2)}\necho:  M420 S1 Z10.00\nok`);
    if (g === 'M420' && /V/.test(cmd)) {
      const head = '      ' + this.mesh[0].map((_, i) => String(i).padEnd(7)).join('');
      const rows = this.mesh.map((r, j) => `${j} ${r.map((v) => (v >= 0 ? '+' : '') + v.toFixed(3)).join(' ')}`);
      return this.say(['Bilinear Leveling Grid:', head, ...rows, 'echo:Bed Leveling ON', 'ok'].join('\n'));
    }
    if (g === 'G29') {
      // measuring takes a while and, like the real one, resets the Z-offset
      const t = setInterval(() => this.say('echo:busy: processing'), 100);
      return setTimeout(() => { clearInterval(t); this.zOffset = -1.95; this.mesh = this.mesh.map((r) => r.map((v) => v * 0.4)); this.say('ok'); }, 800);
    }
    setTimeout(() => this.say('ok'), this.speed);
  }

  close(cb) { this.open = false; clearInterval(this.heat); this.emit('close'); cb?.(); }
}

module.exports = { FakeMarlin };
