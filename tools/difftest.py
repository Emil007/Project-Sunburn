import random,json,subprocess,sys,os,tempfile
from unicorn import *
from unicorn.x86_const import *
R=random.Random(int(sys.argv[1]) if len(sys.argv)>1 else 1)
ALL=0x8d5
def rr(): return R.choice([0,1,2,3,5,6,7])  # avoid sp
def modrm_reg(): return 0xc0|(R.randrange(8)<<3)|R.randrange(8)
def modrm_mem():
    # [bx+si+disp8] etc using bx,si,di small values
    rm=R.choice([0,1,4,5,7,6]); 
    if rm==6: return bytes([(R.randrange(8)<<3)|6, R.randrange(0,0xf0), 0])
    return bytes([0x40|(R.randrange(8)<<3)|rm, R.randrange(0,0x40)])
def mr(): return bytes([modrm_reg()]) if R.random()<0.6 else modrm_mem()
T=[]
for op in range(0x40):
    if op&7<4: T.append(lambda op=op:(bytes([op])+mr(),ALL))
    elif op&7==4: T.append(lambda op=op:(bytes([op,R.randrange(256)]),ALL))
    elif op&7==5: T.append(lambda op=op:(bytes([op,R.randrange(256),R.randrange(256)]),ALL))
T=[t for i,t in enumerate(T)]
def g(f,mask=None): T.append(f)
for op in [0x80,0x81,0x83]:
    g(lambda op=op:(bytes([op])+mr()+bytes([R.randrange(256)]*(2 if op==0x81 else 1)),ALL))
g(lambda:(bytes([R.choice(range(0x40,0x50))]),ALL&~1))
for op in [0xd0,0xd1]: 
    g(lambda op=op:(bytes([op])+mr(),ALL&~0x10))
for op in [0xd2,0xd3,0xc0,0xc1]:
    def f(op=op):
        b=bytes([op])+mr()
        if op in (0xc0,0xc1): b+=bytes([R.randrange(1,33)])
        return b
    g(lambda f=f:(f(),0xc5))  # CF,ZF,SF,PF ; OF undefined for counts>1, AF undefined
g(lambda:(bytes([0xf6,0xe0|R.randrange(8)]),0x801)) # mul r8
g(lambda:(bytes([0xf7,0xe0|R.randrange(8)]),0x801))
g(lambda:(bytes([0xf7,0xe8|R.randrange(8)]),0x801))
g(lambda:(bytes([0xf6,0xe8|R.randrange(8)]),0x801))
g(lambda:(bytes([0x66,0xf7,0xe0|R.choice([1,3,6,7])]),0x801))
g(lambda:(bytes([0x66,0xf7,0xe8|R.choice([1,3,6,7])]),0x801))
g(lambda:(bytes([0x69])+mr()+bytes([R.randrange(256),R.randrange(256)]),0x801))
g(lambda:(bytes([0x6b])+mr()+bytes([R.randrange(256)]),0x801))
g(lambda:(bytes([0x0f,0xaf])+mr(),0x801))
g(lambda:(bytes([0x66,0x0f,0xaf])+mr(),0x801))
g(lambda:(bytes([0xf6,0xd8|R.randrange(8)]),ALL)) # neg
g(lambda:(bytes([0xf7,0xd0|R.randrange(8)]),ALL)) # not
g(lambda:(bytes([0x27]),0xd5)); g(lambda:(bytes([0x2f]),0xd5)); g(lambda:(bytes([0x37]),0x11)); g(lambda:(bytes([0x3f]),0x11))
g(lambda:(bytes([0x98]),ALL)); g(lambda:(bytes([0x99]),ALL)); g(lambda:(bytes([0x66,0x98]),ALL)); g(lambda:(bytes([0x66,0x99]),ALL))
g(lambda:(bytes([0x9e]),ALL)); g(lambda:(bytes([0x9f]),ALL))
g(lambda:(bytes([0x8d])+modrm_mem(),ALL))
g(lambda:(bytes([0x0f,0xb6])+mr(),ALL)); g(lambda:(bytes([0x0f,0xbe])+mr(),ALL)); g(lambda:(bytes([0x66,0x0f,0xbf])+mr(),ALL)); g(lambda:(bytes([0x66,0x0f,0xb7])+mr(),ALL))
g(lambda:(bytes([0x0f,0x90|R.randrange(16),0xc0|R.randrange(8)]),ALL))
for p in [b'',b'\x66']:
  for op in range(0x00,0x40):
    if op&7<4: g(lambda op=op,p=p:(p+bytes([op,modrm_reg()]),ALL))
  g(lambda p=p:(p+bytes([0xd3])+mr(),0xc5))
  g(lambda p=p:(p+bytes([0xc1])+mr()+bytes([R.randrange(0,32)]),0xc5))
g(lambda:(bytes([0x66,0x0f,0xa4,modrm_reg(),R.randrange(1,32)]),0xc5))
g(lambda:(bytes([0x66,0x0f,0xac,modrm_reg(),R.randrange(1,32)]),0xc5))
g(lambda:(bytes([0x0f,0xa4,modrm_reg(),R.randrange(1,16)]),0xc5))
g(lambda:(bytes([0x0f,0xac,modrm_reg(),R.randrange(1,16)]),0xc5))
g(lambda:(bytes([0x0f,0xa3,modrm_reg()]),0x1)); g(lambda:(bytes([0x0f,0xab,modrm_reg()]),0x1)); g(lambda:(bytes([0x0f,0xba,0xe0|R.randrange(0x20),R.randrange(256)]),0x1))
g(lambda:(bytes([0x0f,0xbc,modrm_reg()]),0x40)); g(lambda:(bytes([0x0f,0xbd,modrm_reg()]),0x40))
g(lambda:(bytes([0xf3,R.choice([0xa4,0xa5,0xaa,0xab])]),ALL))
g(lambda:(bytes([R.choice([0xf3,0xf2]),R.choice([0xa6,0xa7,0xae,0xaf])]),ALL))
g(lambda:(bytes([0xfd,0xf3,R.choice([0xa4,0xa5,0xaa,0xab]),0xfc]),ALL))
g(lambda:(bytes([0x60,0x61]),ALL)); g(lambda:(bytes([0x50|rr(),0x58|rr()]),ALL))
g(lambda:(bytes([0xc8,R.randrange(16),0,R.randrange(3),0xc9]),ALL))
g(lambda:(bytes([0x86])+mr(),ALL)); g(lambda:(bytes([0x87])+mr(),ALL))
g(lambda:(bytes([0x66,0xf7,0xf0|R.choice([1,3,6,7])]),0))
g(lambda:(bytes([0xf7,0xf0|R.choice([1,3,6,7])]),0)); g(lambda:(bytes([0xf7,0xf8|R.choice([1,3,6,7])]),0)); g(lambda:(bytes([0xf6,0xf0|R.choice([1,3,6,7])]),0)); g(lambda:(bytes([0xf6,0xf8|R.choice([1,3,6,7])]),0))
cases=[]
N=int(sys.argv[2]) if len(sys.argv)>2 else 3000
for k in range(N):
    code,m=R.choice(T)()
    regs=[R.choice([R.randrange(1<<32),R.randrange(256),R.randrange(1<<16),0,0xffffffff,0x80000000,0x7fff,0x8000]) for _ in range(8)]
    regs[4]=0xff00 # sp
    regs[3]=R.randrange(0x80); regs[6]=R.randrange(0x80); regs[7]=R.randrange(0x80) ; regs[5]=R.randrange(0x80)
    if code[0] in (0xf3,0xf2) or code[:2] in (b'\xfd\xf3',): regs[1]=R.randrange(0,20); 
    if code[0]==0xfd: regs[6]=0x60+R.randrange(0x20); regs[7]=0x60+R.randrange(0x20)
    flags=0x2|R.randrange(0x1000)&0x8d5
    mem=bytes(R.randrange(256) for _ in range(256))
    cases.append(dict(code=code.hex(),regs=regs,flags=flags,mem=mem.hex(),mask=m))
# unicorn
res=[]
for c in cases:
    mu=Uc(UC_ARCH_X86,UC_MODE_16)
    mu.mem_map(0,0x100000)
    code=bytes.fromhex(c['code'])
    mu.mem_write(0x10000,code); mu.mem_write(0x20000,bytes.fromhex(c['mem']))
    mu.reg_write(UC_X86_REG_CS,0x1000);mu.reg_write(UC_X86_REG_DS,0x2000);mu.reg_write(UC_X86_REG_ES,0x2000);mu.reg_write(UC_X86_REG_SS,0x3000)
    for i,r in enumerate([UC_X86_REG_EAX,UC_X86_REG_ECX,UC_X86_REG_EDX,UC_X86_REG_EBX,UC_X86_REG_ESP,UC_X86_REG_EBP,UC_X86_REG_ESI,UC_X86_REG_EDI]): mu.reg_write(r,c['regs'][i])
    mu.reg_write(UC_X86_REG_EFLAGS,c['flags'])
    err=''
    try: mu.emu_start(0x10000,0x10000+len(code))
    except UcError as e: err=str(e)
    res.append(dict(regs=[mu.reg_read(r) for r in [UC_X86_REG_EAX,UC_X86_REG_ECX,UC_X86_REG_EDX,UC_X86_REG_EBX,UC_X86_REG_ESP,UC_X86_REG_EBP,UC_X86_REG_ESI,UC_X86_REG_EDI]],flags=mu.reg_read(UC_X86_REG_EFLAGS),mem=mu.mem_read(0x20000,256).hex(),err=err))
json.dump(cases,open(os.path.join(tempfile.gettempdir(), 'cases.json'),'w'))
subprocess.run(['node',os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'build', 'cputest.js'),os.path.join(tempfile.gettempdir(), 'cases.json'),os.path.join(tempfile.gettempdir(), 'out.json')],check=True)
mine=json.load(open(os.path.join(tempfile.gettempdir(), 'out.json')))
bad=0
for c,u,m in zip(cases,res,mine):
    if u['err']:
        if not m['err']: pass
        continue
    if m['err']: bad+=1; print('ERR',c['code'],m['err']); continue
    probs=[]
    for i in range(8):
        if u['regs'][i]!=m['regs'][i]: probs.append(f"r{i} uc={u['regs'][i]:x} me={m['regs'][i]:x}")
    if (u['flags']^m['flags'])&c['mask']: probs.append(f"flags uc={u['flags']:x} me={m['flags']:x} mask={c['mask']:x}")
    if u['mem']!=m['mem']: probs.append('mem')
    if probs:
        bad+=1
        if bad<=25: print(c['code'], [hex(x) for x in c['regs']], hex(c['flags']), probs)
print('cases',len(cases),'bad',bad)
