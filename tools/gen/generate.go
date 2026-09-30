package main

import (
	"context"
	"fmt"
	"io/fs"

	envelopes "github.com/hollis-labs/go-envelopes"
	"github.com/hollis-labs/go-envelopes/codegen"
)

// Generate loads the manifest rooted at fsys ("manifest/envelopes.yaml",
// "manifest/schemas/<type>.schema.json") and returns the generated TypeScript.
func Generate(ctx context.Context, fsys fs.FS) ([]byte, error) {
	registry, err := envelopes.LoadCore(ctx, envelopes.WithManifestFS(fsys))
	if err != nil {
		return nil, fmt.Errorf("load manifest: %w", err)
	}
	catalog, err := registry.ExportCatalog()
	if err != nil {
		return nil, fmt.Errorf("export catalog: %w", err)
	}
	return codegen.TypeScript(catalog, codegen.TypeScriptOptions{})
}
