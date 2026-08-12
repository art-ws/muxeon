// Release configuration — see CONTRIBUTING.md "Releasing". Manual, dry-run first.
//
// Why this is JS and not the JSON it replaced: the notes generator needs a
// `transform` FUNCTION, which JSON cannot carry.
//
// The stock angular preset renders feat/fix/perf and silently DROPS every other
// type. This project's commits are `T<nn>: subject` (the task convention in
// CONTRIBUTING), so they were all dropped: eight releases' worth of work read as
// an empty changelog while two stray `fix(ci)` commits were the only thing users
// could see. The preset also renders the subject alone and throws the body away
// — and the body is exactly where these commits say what changed and why.
//
// So: T-commits become their own group, the task id rides along as the scope
// (every line stays traceable to the ledger), and the first paragraph of the
// body comes with it as the summary.

/** This project's task convention: `T223: subject`. */
const TASK = /^T\d+$/;

/** Display groups. Anything absent is housekeeping and stays out of the notes. */
const GROUPS = {
  feat: "Features",
  fix: "Bug Fixes",
  perf: "Performance Improvements",
  revert: "Reverts",
  docs: "Documentation",
};

/** Where T-commits land — they are the project's ordinary unit of change. */
const TASK_GROUP = "Changes";

/** How much of the body's opening paragraph to carry. */
const SUMMARY_MAX = 320;

/**
 * Spec coordinates in the subject tail — `(§12.7, FR-70)`. They point at
 * SPEC.md/REQUIREMENTS.md, which live in the private repo (docs/repos.md), so
 * they are noise to a reader of the published changelog. The commit link keeps
 * the full text one click away.
 */
const SPEC_REFS = /\s*\((?:§|FR-|NFR-)[^)]*\)\s*$/;

/** The body's first paragraph, flattened to one line: the "why", not the essay. */
function summarize(body) {
  const paragraph = (body ?? "").split(/\n\s*\n/)[0] ?? "";
  // a trailing colon means the paragraph introduces a list the notes do not carry
  const flat = paragraph.replace(/\s+/g, " ").trim().replace(/:$/, "");
  if (flat === "") return "";
  if (flat.length <= SUMMARY_MAX) return flat;
  // cut on a sentence boundary when there is one, so the summary never breaks
  // off mid-clause
  const window = flat.slice(0, SUMMARY_MAX);
  const stop = Math.max(window.lastIndexOf(". "), window.lastIndexOf("; "));
  return stop > SUMMARY_MAX / 2 ? window.slice(0, stop + 1) : `${window.trimEnd()}…`;
}

/**
 * Shapes a parsed commit into what the default writer template expects. The
 * template itself is untouched — this only decides what reaches it.
 * Returning nothing discards the commit.
 */
function transform(commit) {
  // BREAKING CHANGE notes keep a commit visible whatever its type — a breaking
  // change hidden behind a `chore:` would be the one truly dangerous omission.
  const notes = commit.notes.map((note) => ({ ...note, title: "BREAKING CHANGES" }));
  const type = commit.type ?? "";
  const task = TASK.test(type);
  const group = task ? TASK_GROUP : GROUPS[type];
  if (group === undefined && notes.length === 0) return;

  const subject = (commit.subject ?? "").replace(SPEC_REFS, "");
  const summary = summarize(commit.body);
  return {
    ...commit,
    notes,
    type: group ?? TASK_GROUP,
    // the task id becomes the bold prefix, so the line stays traceable
    scope: task ? type : commit.scope === "*" ? "" : commit.scope,
    // a blank line + two spaces keeps the paragraph inside the bullet
    subject: summary === "" ? subject : `${subject}\n\n  ${summary}`,
    shortHash: typeof commit.hash === "string" ? commit.hash.slice(0, 7) : commit.shortHash,
  };
}

module.exports = {
  branches: ["main"],
  plugins: [
    [
      "@semantic-release/commit-analyzer",
      {
        releaseRules: [
          { type: "T*", release: "patch" },
          { breaking: true, release: "major" },
          { type: "feat", release: "minor" },
          { type: "fix", release: "patch" },
          { type: "perf", release: "patch" },
          { type: "docs", release: false },
          { type: "chore", release: false },
        ],
      },
    ],
    ["@semantic-release/release-notes-generator", { writerOpts: { transform } }],
    ["@semantic-release/changelog", { changelogFile: "CHANGELOG.md" }],
    // Provenance is NOT configurable here: this plugin wraps `npm publish` and
    // exposes no such option, so a `provenance: true` written at this level is
    // silently ignored — which is what shipped 0.1.8 without an attestation.
    // It lives in package.json `publishConfig.provenance`, which npm itself
    // reads. Under trusted publishing npm attests automatically and the missing
    // flag never showed; on token auth it does.
    ["@semantic-release/npm", { npmPublish: true }],
    "@semantic-release/github",
    [
      "@semantic-release/git",
      {
        assets: ["CHANGELOG.md", "package.json"],
        message: "chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}",
      },
    ],
  ],
};
