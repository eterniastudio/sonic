/**
 * Convert Windows' internal verbatim namespace into the normal path form used
 * by the renderer and IPC contracts. Rust performs the authoritative path
 * validation; this prevents a valid folder selected by the native dialog from
 * being sent back as an apparently unsupported device path.
 */
export function externalOutputDirectory(value: string) {
  const path = value.trim();
  if (/^\\\\\?\\UNC\\/i.test(path)) return `\\\\${path.slice(8)}`;
  if (/^\\\\\?\\[a-z]:[\\/]/i.test(path)) return path.slice(4);
  return path;
}
