import { describe, expect, it } from "vitest";
import { externalOutputDirectory } from "../src/domain/path";

describe("output directory IPC paths", () => {
  it("strips Windows' internal verbatim drive prefix", () => {
    expect(externalOutputDirectory(String.raw`\\?\C:\Users\Producer\Downloads\Sonic`))
      .toBe(String.raw`C:\Users\Producer\Downloads\Sonic`);
  });

  it("converts a verbatim UNC path to a normal network path", () => {
    expect(externalOutputDirectory(String.raw`\\?\UNC\studio-nas\beats\Sonic`))
      .toBe(String.raw`\\studio-nas\beats\Sonic`);
  });

  it("preserves normal paths and leaves device paths for Rust to reject", () => {
    expect(externalOutputDirectory(String.raw`C:\Exports\Sonic`)).toBe(String.raw`C:\Exports\Sonic`);
    expect(externalOutputDirectory(String.raw`\\.\PhysicalDrive0`)).toBe(String.raw`\\.\PhysicalDrive0`);
  });
});
