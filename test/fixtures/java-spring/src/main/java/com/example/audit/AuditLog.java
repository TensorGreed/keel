package com.example.audit;

import org.springframework.stereotype.Component;

@Component
public class AuditLog {
  public void record(String s) {}
}
