package com.example.app;

import com.example.api.PaymentGateway;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.stereotype.Service;

@Service
public class QualifiedService {
  private final PaymentGateway gateway;

  public QualifiedService(@Qualifier("fast") PaymentGateway gateway) {
    this.gateway = gateway;
  }
}
