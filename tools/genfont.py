from PIL import Image, ImageDraw, ImageFont
import base64,json
out={}
faces={'r':'/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf','b':'/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'}
for style,path in faces.items():
  for H in [8,10,11,12,13,14,16,18,20,24,28,32]:
    # find pt size so that ascent+descent ~= H
    best=None
    for pt in range(4,64):
        f=ImageFont.truetype(path,pt); a,d=f.getmetrics()
        if a+d<=H: best=(pt,f,a,d)
    pt,f,asc,desc=best
    widths=[];rows=[]
    for c in range(256):
        ch=chr(c) if c>=32 and not (127<=c<160) else ' '
        try: ch=bytes([c]).decode('cp1252')
        except: ch=' '
        if c<32: ch=' '
        euro = ch == '€' and H <= 14   # the outline font's euro sign turns into a blob at small sizes
        if euro: ch = 'C'
        w=max(1,int(round(f.getlength(ch))))
        im=Image.new('L',(w+4,H),0); dr=ImageDraw.Draw(im); dr.text((0,0),ch,font=f,fill=255)
        px=im.load(); bits=[]
        for y in range(H):
            v=0
            for x in range(w): v|=(1 if px[x,y]>=110 else 0)<<x
            bits.append(v)
        if euro:
            # a "C" moved right by one pixel with two bars through it
            rows_on=[y for y in range(H) if bits[y]]
            top,bot=rows_on[0],rows_on[-1]; mid=(top+bot)/2; gap=max(1,round((bot-top)/5))
            w+=1; bits=[(v<<1)&((1<<w)-1) for v in bits]
            for y in (round(mid-gap/2-0.5), round(mid+gap/2+0.5)):
                bits[y]|=(1<<(w-2))-1
        widths.append(w); rows.append(bits)
    # pack: per glyph rows, each row ceil(w/8) bytes
    data=bytearray()
    offs=[]
    for c in range(256):
        offs.append(len(data)); bw=(widths[c]+7)//8
        for v in rows[c]: data+=v.to_bytes(bw,'little')
    out[f'{style}{H}']=dict(h=H,asc=asc,w=widths,o=offs,d=base64.b64encode(bytes(data)).decode())
open('src/win16/fontdata.json','w').write(json.dumps(out))
# also simple 8x16 fixed for fallback (from DejaVu Sans Mono)
f=ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',13)
fixed=bytearray()
for c in range(256):
    try: ch=bytes([c]).decode('cp1252') if c>=32 else ' '
    except: ch=' '
    im=Image.new('L',(8,16),0); ImageDraw.Draw(im).text((0,1),ch,font=f,fill=255); px=im.load()
    for y in range(16):
        v=0
        for x in range(8): v|=(1 if px[x,y]>=110 else 0)<<(7-x)
        fixed.append(v)
open('src/win16/font.ts','w').write('// generated\nimport fontJson from "./fontdata.json";\nexport const FONT_8x16 = Uint8Array.from(atob("%s"), c => c.charCodeAt(0));\nexport const FONTS: Record<string, { h: number; asc: number; w: number[]; o: number[]; d: string }> = fontJson as any;\n' % base64.b64encode(bytes(fixed)).decode())
print('ok', len(json.dumps(out)))
