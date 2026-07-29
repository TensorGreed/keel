package com.example.svc;

import com.example.api.Gateway;
import org.springframework.stereotype.Service;

@Service
public class Checkout {
  private final Gateway gateway;
  public Checkout(Gateway gateway) { this.gateway = gateway; }
}
