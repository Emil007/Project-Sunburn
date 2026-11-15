// Wraps mciSendCommand: films we want to skip complete immediately (the game gets its MM_MCINOTIFY as usual).
const skip = [];
if (api.settings.logo) skip.push('sunflow.avi');
if (api.settings.title) skip.push('titel.avi');
const skipped = new Set();
api.wrapApi('MMSYSTEM.mciSendCommand', ([dev, cmd, flags, parms], orig) => {
  const w = api.win16, m = w.m;
  if (cmd === 0x803 && (flags & 0x200)) { // MCI_OPEN with element name
    const r = orig([dev, cmd, flags, parms]);
    const name = m.str(m.r32(parms, 12)).toLowerCase();
    if (r === 0 && skip.some(s => name.endsWith(s))) skipped.add(m.r16(parms, 4));
    return r;
  }
  if (cmd === 0x806 && skipped.has(dev)) { // MCI_PLAY: jump to the end instead (the game polls the position/mode)
    orig([dev, 0x807, 0x200, parms]);     // MCI_SEEK, MCI_SEEK_TO_END
    if (flags & 1) w.user.post(m.r16(parms, 0), 0x3b9, 1, dev); // MM_MCINOTIFY, MCI_NOTIFY_SUCCESSFUL
    return 0;
  }
  if (cmd === 0x804) skipped.delete(dev);
  return orig([dev, cmd, flags, parms]);
});
