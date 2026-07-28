package com.example.impl;

import com.example.api.PaymentGateway;
import org.springframework.stereotype.Component;

@Component
public class StripeGateway implements PaymentGateway {
  public void pay(int cents) {}
}
