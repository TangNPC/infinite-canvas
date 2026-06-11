package handler

import (
	"path/filepath"
	"testing"

	"github.com/basketikun/infinite-canvas/config"
)

func TestNormalizeReferenceMediaTypeSupportsImages(t *testing.T) {
	tests := []struct {
		name        string
		contentType string
		ext         string
		wantMime    string
		wantExt     string
	}{
		{name: "png mime", contentType: "image/png", ext: ".bin", wantMime: "image/png", wantExt: ".png"},
		{name: "webp ext fallback", contentType: "application/octet-stream", ext: ".webp", wantMime: "image/webp", wantExt: ".webp"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			mimeType, ext, ok := normalizeReferenceMediaType(tt.contentType, tt.ext)
			if !ok {
				t.Fatal("expected media type to be accepted")
			}
			if mimeType != tt.wantMime || ext != tt.wantExt {
				t.Fatalf("got (%q, %q), want (%q, %q)", mimeType, ext, tt.wantMime, tt.wantExt)
			}
		})
	}
}

func TestReferenceMediaTypeMaxBytes(t *testing.T) {
	if got := referenceMediaTypeMaxBytes("image/png"); got != referenceImageMaxBytes {
		t.Fatalf("image max bytes = %d, want %d", got, referenceImageMaxBytes)
	}
}

func TestReferenceMediaDirUsesAbsoluteSQLiteDataDir(t *testing.T) {
	previous := config.Cfg
	t.Cleanup(func() { config.Cfg = previous })
	root := t.TempDir()
	config.Cfg = config.Config{StorageDriver: "sqlite", DatabaseDSN: filepath.Join(root, "infinite-canvas.db")}

	if got := referenceMediaDir(); got != filepath.Join(root, "reference-media") {
		t.Fatalf("referenceMediaDir = %q", got)
	}
}
