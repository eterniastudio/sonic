/**
 * Chooses the version for an automated main-branch release.
 *
 * package.json is the source of truth until a tag exists. After that, every
 * push gets the next patch unless package.json was raised above every tag
 * (an intentional minor or major). A push that already produced a release
 * commit is reused, so a re-run does not mint another version.
 */
import { appendFileSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export function parseSemver(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(value).trim())
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

export function formatSemver(parts) {
  return `${parts[0]}.${parts[1]}.${parts[2]}`
}

export function compareSemver(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index]
  }
  return 0
}

/** Subject of the version-sync commit. The workflow and the re-run check both use this. */
export function releaseCommitSubject(version) {
  return `chore: release v${version} [skip ci]`
}

/**
 * @param {string} packageVersion major.minor.patch from package.json
 * @param {readonly string[]} tags git tags, with or without a leading v
 */
export function nextReleaseVersion(packageVersion, tags) {
  const current = parseSemver(packageVersion)
  if (!current) {
    throw new Error(`package.json version must be major.minor.patch, received ${JSON.stringify(packageVersion)}`)
  }

  const released = []
  for (const tag of tags) {
    const parsed = parseSemver(tag)
    if (parsed) released.push(parsed)
  }
  if (released.length === 0) return formatSemver(current)

  released.sort(compareSemver)
  const latest = released[released.length - 1]
  if (compareSemver(current, latest) > 0) return formatSemver(current)
  return formatSemver([latest[0], latest[1], latest[2] + 1])
}

/**
 * @param {{ packageVersion: string, head: string, refs: readonly { tag: string, commit: string, parent: string, subject: string }[] }} input
 * @returns {{ version: string, mode: 'new' | 'reuse' }}
 */
export function resolveReleaseVersion({ packageVersion, head, refs }) {
  const semverRefs = refs.filter((ref) => parseSemver(ref.tag))
  const children = semverRefs.filter((ref) => {
    const version = formatSemver(parseSemver(ref.tag))
    return ref.parent === head && ref.subject === releaseCommitSubject(version)
  })
  if (children.length > 0) {
    children.sort((left, right) => compareSemver(parseSemver(left.tag), parseSemver(right.tag)))
    return { version: formatSemver(parseSemver(children[children.length - 1].tag)), mode: 'reuse' }
  }

  const declared = parseSemver(packageVersion)
  if (!declared) {
    throw new Error(`package.json version must be major.minor.patch, received ${JSON.stringify(packageVersion)}`)
  }
  const declaredTag = `v${formatSemver(declared)}`
  if (semverRefs.some((ref) => ref.commit === head && ref.tag === declaredTag)) {
    return { version: formatSemver(declared), mode: 'reuse' }
  }

  return {
    version: nextReleaseVersion(packageVersion, semverRefs.map((ref) => ref.tag)),
    mode: 'new'
  }
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim()
}

function loadRefs() {
  const names = git(['tag', '--list', 'v[0-9]*.[0-9]*.[0-9]*']).split(/\r?\n/).filter(Boolean)
  const refs = []
  for (const tag of names) {
    if (!/^v\d+\.\d+\.\d+$/.test(tag)) continue
    const commit = git(['rev-parse', `${tag}^{commit}`])
    let parent = ''
    try {
      parent = git(['rev-parse', `${commit}^`])
    } catch {
      parent = ''
    }
    refs.push({
      tag,
      commit,
      parent,
      subject: git(['log', '-1', '--format=%s', commit])
    })
  }
  return refs
}

function cli() {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
  const result = resolveReleaseVersion({
    packageVersion: pkg.version,
    head: git(['rev-parse', 'HEAD']),
    refs: loadRefs()
  })
  process.stdout.write(`${result.version}\n`)
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `version=${result.version}\nmode=${result.mode}\nsubject=${releaseCommitSubject(result.version)}\n`
    )
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    cli()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`${message}\n`)
    process.exit(1)
  }
}
