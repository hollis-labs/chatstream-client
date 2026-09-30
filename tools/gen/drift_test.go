package main

// These tests pin the manifest to the Go source it describes: the module
// github.com/hollis-labs/go-chatstream at the version in go.mod. They are the
// guard against the manifest (hand-authored JSON Schema) silently drifting from
// the Go types the generated TypeScript claims to mirror.

import (
	"bytes"
	"context"
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	chatstream "github.com/hollis-labs/go-chatstream"
	"github.com/santhosh-tekuri/jsonschema/v6"
)

const root = "../.."

func readJSON(t *testing.T, name string) map[string]any {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(root, "manifest", "schemas", name))
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func sub(t *testing.T, m map[string]any, path ...string) map[string]any {
	t.Helper()
	cur := m
	for _, p := range path {
		next, ok := cur[p].(map[string]any)
		if !ok {
			t.Fatalf("missing %v at %q", path, p)
		}
		cur = next
	}
	return cur
}

func strs(t *testing.T, v any) []string {
	t.Helper()
	arr, ok := v.([]any)
	if !ok {
		t.Fatalf("not an array: %v", v)
	}
	out := make([]string, len(arr))
	for i, e := range arr {
		out[i] = e.(string)
	}
	return out
}

func moduleDir(t *testing.T) string {
	t.Helper()
	out, err := exec.Command("go", "list", "-m", "-f", "{{.Dir}}", "github.com/hollis-labs/go-chatstream").Output()
	if err != nil {
		t.Fatalf("go list -m: %v", err)
	}
	return strings.TrimSpace(string(out))
}

// goConsts returns, per named const type, the values of the constants declared
// with that type (or, for untyped string consts, grouped by name prefix).
func goConsts(t *testing.T, dir string) (typed map[string][]string, untyped map[string]string) {
	t.Helper()
	fset := token.NewFileSet()
	typed = map[string][]string{}
	untyped = map[string]string{}
	files, _ := filepath.Glob(filepath.Join(dir, "*.go"))
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		file, err := parser.ParseFile(fset, f, nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		for _, d := range file.Decls {
			gd, ok := d.(*ast.GenDecl)
			if !ok || gd.Tok != token.CONST {
				continue
			}
			var lastType string
			for _, sp := range gd.Specs {
				vs := sp.(*ast.ValueSpec)
				if vs.Type != nil {
					if id, ok := vs.Type.(*ast.Ident); ok {
						lastType = id.Name
					}
				} else if len(vs.Values) > 0 {
					lastType = ""
				}
				for i, n := range vs.Names {
					if !n.IsExported() {
						continue
					}
					if len(vs.Values) > i {
						if bl, ok := vs.Values[i].(*ast.BasicLit); ok && bl.Kind == token.STRING {
							s, _ := strconv.Unquote(bl.Value)
							if lastType != "" {
								typed[lastType] = append(typed[lastType], s)
							} else {
								untyped[n.Name] = s
							}
							continue
						}
						if lastType != "" { // "= iota": a numeric constant of the type
							typed[lastType] = append(typed[lastType], n.Name)
						}
						continue
					}
					// iota continuation: counts as one more value of lastType.
					if lastType != "" {
						typed[lastType] = append(typed[lastType], n.Name)
					}
				}
			}
		}
	}
	return typed, untyped
}

func sorted(s []string) []string { c := append([]string(nil), s...); sort.Strings(c); return c }

func eq(t *testing.T, what string, manifest, goSrc []string) {
	t.Helper()
	if !reflect.DeepEqual(sorted(manifest), sorted(goSrc)) {
		t.Errorf("%s: manifest %v != go-chatstream %v", what, sorted(manifest), sorted(goSrc))
	}
}

func TestEnumsMatchGoConstants(t *testing.T) {
	ev := readJSON(t, "chatstream-event.schema.json")
	typed, untyped := goConsts(t, moduleDir(t))
	enum := func(def string) []string { return strs(t, sub(t, ev, "$defs", def)["enum"]) }
	eq(t, "Verb", enum("Verb"), typed["Verb"])
	eq(t, "PartKind", enum("PartKind"), typed["PartKind"])
	eq(t, "FinishReason", enum("FinishReason"), typed["FinishReason"])
	eq(t, "ApprovalMode", enum("ApprovalMode"), typed["ApprovalMode"])
	eq(t, "UsageScope", enum("UsageScope"), typed["UsageScope"])
	var gaps, codes []string
	for n, v := range untyped {
		switch {
		case strings.HasPrefix(n, "Gap"):
			gaps = append(gaps, v)
		case strings.HasPrefix(n, "Code"):
			codes = append(codes, v)
		}
	}
	eq(t, "GapReason", enum("GapReason"), gaps)
	eq(t, "ErrorCode", enum("ErrorCode"), codes)
}

func TestCapabilitiesMatchGoStruct(t *testing.T) {
	caps := readJSON(t, "chatstream-capabilities.schema.json")
	props := sub(t, caps, "properties")
	var goFields []string
	rt := reflect.TypeOf(chatstream.Capabilities{})
	for i := 0; i < rt.NumField(); i++ {
		goFields = append(goFields, rt.Field(i).Name)
	}
	var manifestFields []string
	for k := range props {
		manifestFields = append(manifestFields, k)
	}
	eq(t, "Capabilities fields", manifestFields, goFields)
	eq(t, "Capabilities required", strs(t, caps["required"]), goFields)

	// Each numeric enum is 0..n-1 for the n constants Go declares of that type.
	typed, _ := goConsts(t, moduleDir(t))
	for def, goType := range map[string]string{
		"Granularity": "Granularity", "ReasoningCap": "ReasoningCap", "UsageTiming": "UsageTiming",
		"ApprovalCap": "ApprovalCap", "Framing": "Framing",
	} {
		vals, _ := sub(t, caps, "$defs", def)["enum"].([]any)
		if len(vals) != len(typed[goType]) {
			t.Errorf("%s: manifest has %d values, go-chatstream declares %d: %v", def, len(vals), len(typed[goType]), typed[goType])
		}
	}
	// A real Capabilities value marshals to the manifest's shape.
	b, _ := json.Marshal(chatstream.Capabilities{Framing: chatstream.FramingSSE, ResumeCursor: true})
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	for k := range m {
		if _, ok := props[k]; !ok {
			t.Errorf("Capabilities marshals a key %q the manifest lacks", k)
		}
	}
}

func jsonTags(t reflect.Type) (names []string, required []string) {
	for i := 0; i < t.NumField(); i++ {
		tag := t.Field(i).Tag.Get("json")
		name, opts, _ := strings.Cut(tag, ",")
		if name == "" || name == "-" {
			continue
		}
		names = append(names, name)
		if !strings.Contains(opts, "omitempty") {
			required = append(required, name)
		}
	}
	return
}

func keys(m map[string]any) []string {
	var out []string
	for k := range m {
		out = append(out, k)
	}
	return out
}

func TestEventUsageRawMatchGoStructs(t *testing.T) {
	ev := readJSON(t, "chatstream-event.schema.json")
	check := func(what string, gt reflect.Type, schema map[string]any, extra ...string) {
		names, required := jsonTags(gt)
		eq(t, what+" fields", append(keys(sub(t, schema, "properties")), []string{}...), append(names, extra...))
		eq(t, what+" required", strs(t, schema["required"]), required)
	}
	check("Event", reflect.TypeOf(chatstream.Event{}), ev)
	// Usage's MarshalJSON adds the derived "total".
	check("Usage", reflect.TypeOf(chatstream.Usage{}), sub(t, ev, "$defs", "Usage"), "total")
	check("Raw", reflect.TypeOf(chatstream.Raw{}), sub(t, ev, "$defs", "Raw"))
}

func TestGeneratedTypeScriptIsDeterministic(t *testing.T) {
	a, err := Generate(context.Background(), os.DirFS(root))
	if err != nil {
		t.Fatal(err)
	}
	b, _ := Generate(context.Background(), os.DirFS(root))
	if len(a) == 0 || !bytes.Equal(a, b) {
		t.Fatal("generation is empty or non-deterministic")
	}
}

// The manifest accepts what the Go module really produces: every event of every
// adapter's golden file validates, and a field the Go struct does not have does not.
func TestRealGoldenEventsValidateAgainstTheManifest(t *testing.T) {
	c := jsonschema.NewCompiler()
	raw, _ := os.ReadFile(filepath.Join(root, "manifest", "schemas", "chatstream-event.schema.json"))
	doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	if err := c.AddResource("chatstream-event.json", doc); err != nil {
		t.Fatal(err)
	}
	schema, err := c.Compile("chatstream-event.json")
	if err != nil {
		t.Fatal(err)
	}
	goldens, _ := filepath.Glob(filepath.Join(moduleDir(t), "adapter", "*", "testdata", "*.golden.json"))
	if len(goldens) == 0 {
		t.Fatal("found no golden files in go-chatstream")
	}
	n := 0
	for _, g := range goldens {
		b, _ := os.ReadFile(g)
		var events []any
		if err := json.Unmarshal(b, &events); err != nil {
			t.Fatalf("%s: %v", g, err)
		}
		for i, e := range events {
			if err := schema.Validate(e); err != nil {
				t.Errorf("%s event %d: %v", g, i, err)
			}
			n++
		}
	}
	if n == 0 {
		t.Fatal("validated no events")
	}
	bad := map[string]any{"v": "1", "seq": 0, "run_id": "r", "time": time.Now().Format(time.RFC3339), "verb": "run.start", "invented_field": 1}
	if schema.Validate(bad) == nil {
		t.Error("an event with a field Go's Event does not have was accepted")
	}
}
