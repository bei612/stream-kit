These self-signed certificate and unencrypted EC keys are public test fixtures.
They were generated solely for configuration tests, are not trusted by any
deployment, and must never be used for a service. The second key deliberately
does not match the certificate. Tests use them without requiring OpenSSL at run
time. The `.fixture` suffix distinguishes them from local deployment secrets.
