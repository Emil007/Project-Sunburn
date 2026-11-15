"""Browser end-to-end smoke test (Playwright).

    npm run build && npm run serve &      # http://localhost:8080
    python3 tools/e2e_browser.py --disc path/to/isle.mds path/to/isle.mdf [--chrome /usr/bin/google-chrome]

Imports the disc, starts the game, clicks Start and saves screenshots plus the session log in ./e2e-out.
"""
import argparse, asyncio, os
from playwright.async_api import async_playwright

ap = argparse.ArgumentParser()
ap.add_argument('--disc', nargs='+', required=True)
ap.add_argument('--chrome', default=None)
ap.add_argument('--url', default='http://localhost:8080/')
ap.add_argument('--out', default='e2e-out')
args = ap.parse_args()

async def main():
    os.makedirs(args.out, exist_ok=True)
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path=args.chrome, args=['--autoplay-policy=no-user-gesture-required', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'])
        pg = await b.new_page(viewport={'width': 1280, 'height': 800})
        await pg.goto(args.url); await pg.wait_for_timeout(1500)
        print('crossOriginIsolated:', await pg.evaluate('crossOriginIsolated'))
        await pg.set_input_files('#filePick', args.disc)
        for _ in range(240):
            st = await pg.inner_text('#importStatus')
            if '✓' in st or 'err' in (await pg.get_attribute('#importStatus', 'class') or ''): break
            await pg.wait_for_timeout(1000)
        print('import:', st)
        await pg.evaluate("""(()=>{const st=JSON.parse(localStorage.getItem('hi.mods'));st.enabled['skip-intros']=true;st.settings['skip-intros']={logo:true,title:true};localStorage.setItem('hi.mods',JSON.stringify(st));})()""")
        await pg.reload(); await pg.wait_for_timeout(1500)
        await pg.click('#playBtn')
        await pg.wait_for_timeout(20000)
        await pg.screenshot(path=f'{args.out}/1-start.png')
        r = await pg.evaluate("(()=>{const c=document.getElementById('screen').getBoundingClientRect();return [c.width,c.height]})()")
        s = min(r[0] / 640, r[1] / 480); ox = (r[0] - 640 * s) / 2; oy = (r[1] - 480 * s) / 2
        await pg.mouse.click(ox + 478 * s, oy + 389 * s)   # "Start"
        await pg.wait_for_timeout(30000)
        await pg.screenshot(path=f'{args.out}/2-game.png')
        open(f'{args.out}/log.txt', 'w').write(await pg.evaluate('window.__hi.logText()'))
        await b.close()
    print('results in', args.out)

asyncio.run(main())
