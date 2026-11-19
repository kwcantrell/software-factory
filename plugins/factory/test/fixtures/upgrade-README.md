# upgrade-<commit> fixtures

Factory dirs written by the original Python CLI at two commits of this repository, for
`upgrade.test.ts`:

- `upgrade-979c870/`: the initial CLI; its jobs have no `followups` field.
- `upgrade-d7923b8/`: the CLI with follow-ups and `specs_dir`; with a `factory.json` that sets
  `specs_dir`.

Each holds `factory/` (the dashboard that CLI installed, its empty `.lock`, and jobs
`001-intake-job` at intake, `002-build-job` at build, `003-ship-job` at ship after one approving
round, `004-done-job` merged) and `expected/` (that CLI's `status` and `stats` output on them).
Machine-specific values are placeholders the tests fill in: `<FACTORY>` for the factory dir and
`<BASE>` for the commit the jobs were cut from. The worktrees and `factory/.gitignore` (whose `*`
would hide the fixture from git) are not kept; the tests recreate the worktrees and branches of jobs
002 and 003, and the upgrade must recreate `.gitignore`.

They were made with this script (`gen <commit> <out dir>`), run once and committed:

```bash
set -euo pipefail
commit=$1 out=$2 src=$(git rev-parse --show-toplevel)
tmp=$(mktemp -d); unset FACTORY_DIR
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_AUTHOR_NAME=Test GIT_AUTHOR_EMAIL=test@example.invalid GIT_COMMITTER_NAME=Test GIT_COMMITTER_EMAIL=test@example.invalid
mkdir -p "$tmp/plugin/bin" "$tmp/plugin/dashboard" "$tmp/repo"
git -C "$src" show "$commit:bin/factory" > "$tmp/plugin/bin/factory"
git -C "$src" show "$commit:dashboard/index.html" > "$tmp/plugin/dashboard/index.html"
cd "$tmp/repo"
git init -q -b main; echo test > README.md; git add README.md; git commit -qm initial
if [ "$commit" = d7923b8 ]; then printf '{\n  "specs_dir": "docs/specs",\n  "max_review_rounds": 2\n}\n' > factory.json; git add factory.json; git commit -qm config; fi
f() { python3 -I "$tmp/plugin/bin/factory" "$@"; }
f init >/dev/null
TASK=$'# A job\n\n## Acceptance criteria\n\n1. It works.\n'
f new Intake job >/dev/null
f new Build job >/dev/null
f new Ship job >/dev/null
f new Done job >/dev/null
for i in 002-build-job 003-ship-job 004-done-job; do printf '%s' "$TASK" > factory/jobs/$i/task.md; f start $i >/dev/null; done
f note 2 builder working >/dev/null
for i in 003-ship-job 004-done-job; do
  wt=factory/worktrees/$i; echo "$i" > $wt/$i.txt; git -C $wt add .; git -C $wt commit -qm "work $i"
  for n in build.md proof.md review-1-security.md review-1-standards.md review-1-behavior.md; do echo '# notes' > factory/jobs/$i/$n; done
  f built $i >/dev/null; f proof $i pass >/dev/null; f round $i >/dev/null
  for r in security standards behavior; do f verdict $i $r approve >/dev/null; done
done
if [ "$commit" = d7923b8 ]; then
  f followup add 2 --by builder "Ünïcode follow-up" >/dev/null
  f followup add 3 --by security "a later fix" >/dev/null
  f followup add 4 --by verifier "done already" >/dev/null
  f followup done 4 1 job 099 >/dev/null
fi
f merge 4 >/dev/null
f status > "$tmp/status.txt"; f stats > "$tmp/stats.txt"
base=$(git -C "$tmp/repo" rev-parse HEAD^1)
rm -rf "$out"; mkdir -p "$out"
cp -r factory "$out/factory"; rm -rf "$out/factory/worktrees" "$out/factory/.gitignore"; mkdir "$out/expected"; cp "$tmp/status.txt" "$tmp/stats.txt" "$out/expected/"
[ -f factory.json ] && cp factory.json "$out/factory.json"
# Machine-specific values become placeholders the tests fill in.
find "$out" -name job.json -print0 | xargs -0 sed -i "s#$tmp/repo/factory#<FACTORY>#g; s#$base#<BASE>#g"
rm -rf "$tmp"
```
