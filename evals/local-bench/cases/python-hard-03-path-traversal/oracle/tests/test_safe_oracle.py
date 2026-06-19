import os

import pytest

from safe import safe_join


def test_absolute_path_is_rejected():
    with pytest.raises(ValueError):
        safe_join("/srv/data", "/etc/passwd")


def test_normalized_traversal_is_rejected():
    with pytest.raises(ValueError):
        safe_join("/srv/data", "a/../../etc/passwd")


def test_legitimate_nested_path_is_allowed():
    result = safe_join("/srv/data", "sub/file.txt")
    assert result == os.path.realpath("/srv/data/sub/file.txt")
