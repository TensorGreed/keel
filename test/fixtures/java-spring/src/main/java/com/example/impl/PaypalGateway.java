package com.example.impl;

import com.example.api.PaymentGateway;
import org.springframework.stereotype.Service;

@Service
public class PaypalGateway implements PaymentGateway {
  public void pay(int cents) {}
}
