'use strict';

// File names of run-frozen.js records and logs, for the writer and every reader that derives a name from a target.
// A target is `suite`, `red` or `<kind>:<ID>`. On POSIX the stem is the target itself (`proof:<ID>.record.json`), as
// before, so existing evidence keeps its names. NTFS reads `a:b` as stream `b` of file `a`, so on win32 the ':' becomes
// '_' (`proof_<ID>.record.json`); no target kind or id holds '_', so the name stays unambiguous. Records never
// existed on win32 under ':' names (the write failed), so there is no old name to read there.
const targetStem = (target, platform = process.platform) => (platform === 'win32' ? target.replace(':', '_') : target);
const recordName = (target, platform) => `${targetStem(target, platform)}.record.json`;

module.exports = { targetStem, recordName };
