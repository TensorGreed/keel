package com.example.g;

import org.junit.jupiter.api.Test;

public class WidgetTest {
  @Test
  public void size() {
    if (new Widget().size() != 3) throw new AssertionError();
  }
}
