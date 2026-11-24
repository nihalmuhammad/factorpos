/**
 * FactorPOS ZATCA edition installer (see shared/edition.ts).
 *
 * Same app as the KOT edition (package.json "build"), with its own identity so the two
 * never mix on a PC or through updates:
 *   - app ID com.factorpos.zatca and product name "FactorPOS ZATCA": its own install
 *     folder, shortcuts and data folder (%APPDATA%\FactorPOS ZATCA);
 *   - factorposEdition "zatca" in the packaged package.json (read by main/edition.ts);
 *   - its own update feed: the "zatca-updates" release of this repository (a fixed
 *     prerelease the release workflow refreshes), read with the generic provider. The
 *     KOT edition's GitHub feed never sees it: that tag is not a version.
 *
 * Usage: npx electron-builder --config scripts/editions/electron-builder-zatca.cjs --win nsis --x64
 */
const base = require('../../package.json').build;

const PRODUCT_NAME = 'FactorPOS ZATCA';
const owner = base.publish.owner;
const repo = base.publish.repo;

module.exports = {
  ...base,
  appId: 'com.factorpos.zatca',
  productName: PRODUCT_NAME,
  extraMetadata: {
    ...(base.extraMetadata || {}),
    productName: PRODUCT_NAME,
    factorposEdition: 'zatca',
  },
  win: {
    ...base.win,
    artifactName: 'factorpos-zatca-${version}-win-${arch}.${ext}',
  },
  appx: {
    ...base.appx,
    applicationId: 'FactorPOSZATCA',
    identityName: 'FactorPOS.FactorPOSZATCA',
    displayName: PRODUCT_NAME,
  },
  publish: {
    provider: 'generic',
    url: `https://github.com/${owner}/${repo}/releases/download/zatca-updates`,
    channel: 'latest',
  },
};
