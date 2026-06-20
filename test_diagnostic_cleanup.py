#!/usr/bin/env python3
"""Tests for the diagnostic cleanup functionality in build.py."""

import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

# We'll import from build.py by adding it to the path
import sys
sys.path.insert(0, str(Path(__file__).parent))

from build import (
    cleanup_stale_diagnostics,
    get_stale_diagnostic_artifacts,
    current_commit_id,
)


class TestDiagnosticCleanup(unittest.TestCase):
    """Test suite for diagnostic cleanup functionality."""

    def setUp(self):
        """Create a temporary directory for testing."""
        self.test_dir = tempfile.mkdtemp(prefix="tent-trials-test-")
        self.diagnostic_dir = Path(self.test_dir) / "diagnostic"
        self.diagnostic_dir.mkdir(parents=True, exist_ok=True)

    def tearDown(self):
        """Clean up the temporary directory."""
        if Path(self.test_dir).exists():
            shutil.rmtree(self.test_dir)

    def test_dry_run_does_not_delete_files(self):
        """Verify that dry-run mode doesn't delete any files."""
        # Create some test artifacts
        old_logd = self.diagnostic_dir / "build-abc12345.logd"
        old_logd.write_text("old log data")
        old_metadata = self.diagnostic_dir / "build-abc12345.json"
        old_metadata.write_text('{"status": "old"}')

        # Run cleanup in dry-run mode
        deleted, total_bytes = cleanup_stale_diagnostics(dry_run=True, verbose=False)

        # Files should still exist
        self.assertTrue(old_logd.exists())
        self.assertTrue(old_metadata.exists())
        self.assertEqual(len(deleted), 2)
        self.assertGreater(total_bytes, 0)

    def test_apply_mode_deletes_files(self):
        """Verify that apply mode actually deletes files."""
        # Create some test artifacts
        old_logd = self.diagnostic_dir / "build-abc12345.logd"
        old_logd.write_text("old log data")
        old_metadata = self.diagnostic_dir / "build-abc12345.json"
        old_metadata.write_text('{"status": "old"}')

        # Patch the current_commit_id to return a different commit
        with patch('build.current_commit_id', return_value='def67890'):
            # Run cleanup in apply mode
            deleted, total_bytes = cleanup_stale_diagnostics(
                dry_run=False, verbose=False
            )

            # Files should be deleted
            self.assertFalse(old_logd.exists())
            self.assertFalse(old_metadata.exists())
            self.assertEqual(len(deleted), 2)

    def test_preserves_current_commit_artifacts(self):
        """Verify that current commit's artifacts are never deleted."""
        current_commit = "abc12345"

        # Create artifacts for the current commit and old commits
        current_logd = self.diagnostic_dir / f"build-{current_commit}.logd"
        current_logd.write_text("current log data")
        current_metadata = self.diagnostic_dir / f"build-{current_commit}.json"
        current_metadata.write_text('{"status": "current"}')

        old_logd = self.diagnostic_dir / "build-def67890.logd"
        old_logd.write_text("old log data")

        # Patch the current_commit_id to return the current commit
        with patch('build.current_commit_id', return_value=current_commit):
            # Run cleanup in apply mode
            deleted, total_bytes = cleanup_stale_diagnostics(
                dry_run=False, verbose=False
            )

            # Current commit artifacts should still exist
            self.assertTrue(current_logd.exists())
            self.assertTrue(current_metadata.exists())
            # Old artifacts should be deleted
            self.assertFalse(old_logd.exists())
            self.assertEqual(len(deleted), 1)

    def test_ignores_fallback_commit_id(self):
        """Verify that build-00000000.* files are never touched."""
        # Create fallback commit artifacts (00000000 is the fallback when git is unavailable)
        fallback_logd = self.diagnostic_dir / "build-00000000.logd"
        fallback_logd.write_text("fallback log data")
        fallback_metadata = self.diagnostic_dir / "build-00000000.json"
        fallback_metadata.write_text('{"status": "fallback"}')

        # Patch the current_commit_id to return something else
        with patch('build.current_commit_id', return_value='abc12345'):
            # Run cleanup in apply mode
            deleted, total_bytes = cleanup_stale_diagnostics(
                dry_run=False, verbose=False
            )

            # Fallback files should not be deleted
            self.assertTrue(fallback_logd.exists())
            self.assertTrue(fallback_metadata.exists())
            self.assertEqual(len(deleted), 0)

    def test_handles_partial_chunks(self):
        """Verify that partial .logd chunks from incomplete runs are found."""
        # Create partial chunks
        chunk1 = self.diagnostic_dir / "build-abc12345-part001.logd"
        chunk1.write_text("chunk 1 data")
        chunk2 = self.diagnostic_dir / "build-abc12345-part002.logd"
        chunk2.write_text("chunk 2 data")

        # Patch the current_commit_id to return a different commit
        with patch('build.current_commit_id', return_value='def67890'):
            # Get stale artifacts (don't delete yet, just find them)
            stale = get_stale_diagnostic_artifacts()
            self.assertEqual(len(stale), 2)

    def test_handles_empty_diagnostic_directory(self):
        """Verify that cleanup handles an empty diagnostic directory gracefully."""
        # Ensure directory is empty
        for f in self.diagnostic_dir.glob("*"):
            if f.is_file():
                f.unlink()

        # Run cleanup
        deleted, total_bytes = cleanup_stale_diagnostics(
            dry_run=True, verbose=False
        )

        # Should have no artifacts to clean
        self.assertEqual(len(deleted), 0)
        self.assertEqual(total_bytes, 0)

    def test_handles_nonexistent_diagnostic_directory(self):
        """Verify that cleanup handles a missing diagnostic directory."""
        # Remove the directory
        shutil.rmtree(self.diagnostic_dir)

        # Run cleanup
        deleted, total_bytes = cleanup_stale_diagnostics(
            dry_run=True, verbose=False
        )

        # Should have no artifacts to clean
        self.assertEqual(len(deleted), 0)
        self.assertEqual(total_bytes, 0)


if __name__ == "__main__":
    unittest.main()
