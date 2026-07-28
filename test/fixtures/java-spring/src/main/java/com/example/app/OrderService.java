package com.example.app;

import com.example.api.PaymentGateway;
import com.example.audit.AuditLog;
import com.example.config.Ledger;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

@Service
public class OrderService {
  private final PaymentGateway gateway;
  private final Ledger ledger;

  @Autowired
  private AuditLog audit;

  public OrderService(PaymentGateway gateway, Ledger ledger) {
    this.gateway = gateway;
    this.ledger = ledger;
  }
}
