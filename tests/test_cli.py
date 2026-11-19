"""Tests for bin/factory, driving the real CLI as a subprocess against a throwaway git repo.

Run: python3 -I -B -m unittest discover -s tests
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

FACTORY = Path(__file__).resolve().parent.parent / "bin" / "factory"
TASK = "# A job\n\n## Acceptance criteria\n\n1. It works.\n"


class FactoryCLI(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.repo = Path(tmp.name).resolve() / "repo"
        self.repo.mkdir()
        self.fdir = self.repo / "factory"
        # Never inherit the developer's git config, repo or factory dir.
        env = {k: v for k, v in os.environ.items() if not k.startswith(("GIT_", "FACTORY_"))}
        env.update(HOME=tmp.name, FACTORY_DIR=str(self.fdir), GIT_CONFIG_NOSYSTEM="1",
                   GIT_CONFIG_GLOBAL=os.devnull, GIT_AUTHOR_NAME="Test", GIT_AUTHOR_EMAIL="test@example.invalid",
                   GIT_COMMITTER_NAME="Test", GIT_COMMITTER_EMAIL="test@example.invalid")
        self.env = env
        self.git("init", "-q", "-b", "main")
        (self.repo / "README.md").write_text("test repo\n")
        self.git("add", "README.md")
        self.git("commit", "-q", "-m", "initial")

    def git(self, *args, cwd=None):
        return subprocess.run(["git", *args], cwd=cwd or self.repo, env=self.env, check=True,
                              capture_output=True, text=True).stdout.strip()

    def factory(self, *args, cwd=None):
        return subprocess.run([sys.executable, "-I", str(FACTORY), *args], cwd=cwd or self.repo,
                              env=self.env, capture_output=True, text=True)

    def ok(self, *args, cwd=None):
        p = self.factory(*args, cwd=cwd)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        return p.stdout

    def job(self, job_id):
        return json.loads((self.fdir / "jobs" / job_id / "job.json").read_text())

    def new_job(self, title="Add a thing"):
        return self.ok("new", title).splitlines()[0]

    def started_job(self):
        job_id = self.new_job()
        (self.fdir / "jobs" / job_id / "task.md").write_text(TASK)
        self.ok("start", job_id)
        return job_id

    # ------------------------------------------------------------------ tests

    def test_init_creates_runtime_dir_that_ignores_itself(self):
        out = self.ok("init")
        self.assertIn("factory ready at", out)
        self.assertTrue((self.fdir / "jobs").is_dir())
        self.assertEqual((self.fdir / ".gitignore").read_text().splitlines()[-1], "*")
        self.assertTrue((self.fdir / "index.html").is_file())
        self.assertEqual(self.git("status", "--porcelain"), "", "factory/ must not show up in git status")

    def test_new_opens_job_in_intake(self):
        job_id = self.new_job("Add cursor pagination")
        self.assertEqual(job_id, "001-add-cursor-pagination")
        job = self.job(job_id)
        self.assertEqual((job["stage"], job["status"]), ("intake", "active"))
        self.assertEqual(self.new_job("Second"), "002-second")

    def test_start_creates_worktree_and_branch(self):
        job_id = self.started_job()
        job = self.job(job_id)
        self.assertEqual(job["stage"], "build")
        self.assertEqual(job["branch"], f"factory/{job_id}")
        self.assertEqual(job["base_branch"], "main")
        self.assertEqual(job["base"], self.git("rev-parse", "HEAD"))
        wt = Path(job["worktree"])
        self.assertEqual(wt, self.fdir / "worktrees" / job_id)
        self.assertTrue((wt / "README.md").is_file())
        self.assertEqual(self.git("rev-parse", "--abbrev-ref", "HEAD", cwd=wt), job["branch"])
        self.assertIn(job["branch"], self.git("branch", "--list", job["branch"]))

    def test_start_without_task_md_is_refused(self):
        job_id = self.new_job()
        p = self.factory("start", job_id)
        self.assertEqual(p.returncode, 1, p.stdout + p.stderr)
        self.assertIn("refused", p.stderr)
        self.assertIn("task.md", p.stderr)
        self.assertEqual(self.job(job_id)["stage"], "intake")
        self.assertFalse((self.fdir / "worktrees" / job_id).exists())

    def test_start_without_acceptance_criteria_is_refused(self):
        job_id = self.new_job()
        (self.fdir / "jobs" / job_id / "task.md").write_text("# A job\n\nDo it.\n")
        p = self.factory("start", job_id)
        self.assertEqual(p.returncode, 1, p.stdout + p.stderr)
        self.assertIn("Acceptance criteria", p.stderr)

    def test_built_with_no_commits_is_refused(self):
        job_id = self.started_job()
        (self.fdir / "jobs" / job_id / "build.md").write_text("# Build\n")
        p = self.factory("built", job_id)
        self.assertEqual(p.returncode, 1, p.stdout + p.stderr)
        self.assertIn("no commits", p.stderr)
        self.assertEqual(self.job(job_id)["stage"], "build")

    def test_built_with_a_commit_moves_to_proof(self):
        job_id = self.started_job()
        wt = Path(self.job(job_id)["worktree"])
        (wt / "thing.txt").write_text("thing\n")
        self.git("add", "thing.txt", cwd=wt)
        self.git("commit", "-q", "-m", "Add thing", cwd=wt)
        (self.fdir / "jobs" / job_id / "build.md").write_text("# Build\n")
        self.ok("built", job_id, cwd=wt)  # from inside the worktree, as the builder does
        self.assertEqual(self.job(job_id)["stage"], "proof")

    def test_human_escalates_with_exit_2(self):
        job_id = self.new_job()
        p = self.factory("human", job_id, "which database?")
        self.assertEqual(p.returncode, 2, p.stdout + p.stderr)
        self.assertIn("escalated to a human", p.stderr)
        job = self.job(job_id)
        self.assertEqual((job["status"], job["needs_human"]), ("needs-human", "which database?"))
        # A job waiting on a human is refused until a human resumes it.
        (self.fdir / "jobs" / job_id / "task.md").write_text(TASK)
        self.assertEqual(self.factory("start", job_id).returncode, 1)
        self.ok("resume", job_id)
        self.ok("start", job_id)

    def test_repeated_proof_failures_escalate_with_exit_2(self):
        (self.repo / "factory.json").write_text('{"max_proof_attempts": 1}\n')
        job_id = self.started_job()
        wt = Path(self.job(job_id)["worktree"])
        (wt / "x.txt").write_text("x\n")
        self.git("add", "x.txt", cwd=wt)
        self.git("commit", "-q", "-m", "x", cwd=wt)
        for name in ("build.md", "proof.md"):
            (self.fdir / "jobs" / job_id / name).write_text("# notes\n")
        self.ok("built", job_id)
        p = self.factory("proof", job_id, "fail")
        self.assertEqual(p.returncode, 2, p.stdout + p.stderr)
        self.assertEqual(self.job(job_id)["status"], "needs-human")

    def test_config_prints_defaults(self):
        cfg = json.loads(self.ok("config"))
        self.assertEqual(cfg["reviewers"], ["security", "standards", "behavior"])
        self.assertIs(cfg["spec_gate"], False)

    def test_config_rejects_unknown_key(self):
        (self.repo / "factory.json").write_text('{"max_review_round": 2}\n')
        p = self.factory("config")
        self.assertEqual(p.returncode, 1, p.stdout + p.stderr)
        self.assertIn("unknown key 'max_review_round'", p.stderr)

    def test_config_rejects_bad_value(self):
        (self.repo / "factory.json").write_text('{"spec_gate": "yes"}\n')
        p = self.factory("config")
        self.assertEqual(p.returncode, 1, p.stdout + p.stderr)
        self.assertIn("spec_gate", p.stderr)


if __name__ == "__main__":
    unittest.main()
