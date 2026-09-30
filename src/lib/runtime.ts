// keep runtime diagnostics aligned with the node versions supported by npm 12.
export const NODE_REQUIREMENT = 'Node 22.22.2+, 24.15+, or 26+';
export function supportedNode(version = process.versions.node): boolean {
  const [major, minor, patch] = version.split('.').map(Number);
  return (major === 22 && (minor > 22 || (minor === 22 && patch >= 2))) || (major === 24 && minor >= 15) || major >= 26;
}
