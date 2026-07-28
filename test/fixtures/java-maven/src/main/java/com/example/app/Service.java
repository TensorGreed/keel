package com.example.app;

import com.example.util.Helper;
import com.example.util.*;
import static com.example.util.Constants.MAX;

public class Service {
  public int run() {
    return Helper.help() + MAX + Support.bump();
  }
}
