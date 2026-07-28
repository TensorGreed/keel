package greet

import "example.com/app/internal/util"

type Greeter struct{}

func (gr Greeter) Greet() string { return util.Helper() }

func Hello() string { return "hi" }

var Prefix = ">"

const Version = "1.0"
