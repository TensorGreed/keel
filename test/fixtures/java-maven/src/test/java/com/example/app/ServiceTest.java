package com.example.app;

import org.junit.Test;

public class ServiceTest {
  @Test
  public void testRun() {
    if (new Service().run() != 13) throw new AssertionError();
  }
}
