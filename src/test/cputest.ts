import { Memory } from '../core/memory';
import { CPU } from '../core/cpu';
import * as fs from 'fs';
// input: JSON list of cases {code:hex, regs:[8], flags, mem:hex(256 bytes at ds:0)}
const cases = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const out: any[] = [];
for (const c of cases) {
  const mem = new Memory();
  const cpu = new CPU(mem);
  // segments: code at 0x10000, data at 0x20000, stack at 0x30000
  mem.setDesc(0x0f, { base: 0x10000, limit: 0xffff, code: true, present: true });
  mem.setDesc(0x17, { base: 0x20000, limit: 0xffff, code: false, present: true });
  mem.setDesc(0x1f, { base: 0x30000, limit: 0xffff, code: false, present: true });
  const code = Buffer.from(c.code, 'hex'); mem.u8.set(code, 0x10000);
  mem.u8.set(Buffer.from(c.mem, 'hex'), 0x20000);
  cpu.loadSeg(1, 0x0f); cpu.loadSeg(3, 0x17); cpu.loadSeg(0, 0x17); cpu.loadSeg(2, 0x1f);
  for (let i = 0; i < 8; i++) cpu.r[i] = c.regs[i];
  cpu.flags = c.flags; cpu.ip = 0;
  let err = '';
  try { while (cpu.ip < code.length) cpu.step(); } catch (e: any) { err = e.message; }
  out.push({ regs: Array.from(cpu.r).map(x => x >>> 0), flags: cpu.flags, mem: Buffer.from(mem.u8.subarray(0x20000, 0x20100)).toString('hex'), err });
}
fs.writeFileSync(process.argv[3], JSON.stringify(out));
