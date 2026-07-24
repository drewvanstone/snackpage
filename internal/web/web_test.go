package web_test

import (
	"io"
	"testing"

	"github.com/drewvanstone/snackpage/internal/web"
)

func TestFS_ContainsIndex(t *testing.T) {
	f, err := web.FS.Open("assets/index.html")
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := f.Close(); err != nil {
			t.Errorf("close embedded file: %v", err)
		}
	}()
	body, _ := io.ReadAll(f)
	if len(body) == 0 {
		t.Error("index.html is empty")
	}
}
