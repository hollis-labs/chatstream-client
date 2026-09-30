// Command gen emits src/generated/chatstream-types.generated.ts from this
// repository's manifest (manifest/envelopes.yaml and manifest/schemas/), using
// go-envelopes' own generator: envelopes.LoadCore over the manifest, then
// codegen.TypeScript. That is exactly what go-envelopes' cmd/envelopes-export
// does for go-envelopes' embedded manifest; the command has no flag for another
// manifest, so this is the same two calls with the manifest filesystem swapped
// through the public envelopes.WithManifestFS option. go-envelopes itself is
// consumed at a released version and not modified.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
)

func main() {
	root := flag.String("root", ".", "repository root holding manifest/envelopes.yaml")
	output := flag.String("output", "-", "output file, or - for stdout")
	flag.Parse()

	content, err := Generate(context.Background(), os.DirFS(*root))
	if err != nil {
		fmt.Fprintln(os.Stderr, "gen:", err)
		os.Exit(1)
	}
	if *output == "-" {
		_, _ = os.Stdout.Write(content)
		return
	}
	if err := os.WriteFile(*output, content, 0o644); err != nil {
		fmt.Fprintln(os.Stderr, "gen:", err)
		os.Exit(1)
	}
}
