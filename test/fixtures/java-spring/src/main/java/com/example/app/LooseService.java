package com.example.app;

import com.example.api.PaymentGateway;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.stereotype.Service;

@Service
public class LooseService {
  public LooseService(@Qualifier("ghostBean") PaymentGateway gateway) {}
}
