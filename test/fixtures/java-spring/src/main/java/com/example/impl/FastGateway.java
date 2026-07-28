package com.example.impl;

import com.example.api.PaymentGateway;
import org.springframework.stereotype.Component;

@Component("fast")
public class FastGateway implements PaymentGateway {
  public void pay(int cents) {}
}
