const november18 = require('./ogp-numbering-2026-11-18.expected.json');
const bothModes = { C143: ['C142', '85'] };

module.exports = { legacy: { ...november18, ...bothModes }, 'ld-v3': bothModes };
