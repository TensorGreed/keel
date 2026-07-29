package com.example.impl;

import com.example.api.Gateway;
import org.springframework.stereotype.Component;

@Component
public class StripeGateway implements Gateway {
  public void pay() {}
}
