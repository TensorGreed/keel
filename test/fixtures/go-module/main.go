package main

import (
	g "example.com/app/greet"
	. "example.com/app/dotpkg"
	_ "example.com/app/sidepkg"
)

func main() {
	_ = g.Hello()
	_ = Dotted()
}
