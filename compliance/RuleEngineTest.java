package com.tentoftrials.compliance;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.HashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/**
 * JUnit 5 tests for RuleEngine compliance evaluation logic.
 *
 * These tests ensure that the extracted RuleEngine maintains
 * the original behavior after refactoring.
 */
@DisplayName("RuleEngine Compliance Tests")
public class RuleEngineTest {

    private RuleEngine ruleEngine;

    @BeforeEach
    void setUp() {
        ruleEngine = new RuleEngine();
    }

    @Test
    @DisplayName("KYC check passes when user is verified")
    void testKYCPassWhenVerified() {
        Map<String, Object> data = new HashMap<>();
        data.put("user_id", "user123");
        data.put("kyc_status", "verified");
        data.put("is_pep", false);

        ComplianceAuditor.ComplianceResult result = ruleEngine.evaluate("KYC", data);

        assertTrue(result.isCompliant(), "KYC check should pass for verified users");
        assertTrue(result.getViolations().isEmpty(), "No violations should be reported");
    }

    @Test
    @DisplayName("KYC check fails when user status is pending")
    void testKYCFailWhenPending() {
        Map<String, Object> data = new HashMap<>();
        data.put("user_id", "user456");
        data.put("kyc_status", "pending");
        data.put("is_pep", false);

        ComplianceAuditor.ComplianceResult result = ruleEngine.evaluate("KYC", data);

        assertFalse(result.isCompliant(), "KYC check should fail for pending users");
        assertFalse(result.getViolations().isEmpty(), "Violations should be reported");
    }

    @Test
    @DisplayName("AML check flags high-value transactions")
    void testAMLFlagsHighValueTransactions() {
        Map<String, Object> data = new HashMap<>();
        data.put("transaction_amount", 50000.00);

        ComplianceAuditor.ComplianceResult result = ruleEngine.evaluate("AML", data);

        assertFalse(result.isCompliant(), "AML check should fail for high-value transactions");
        assertFalse(result.getViolations().isEmpty(), "AML violations should be reported");
        assertTrue(result.getSummary().contains("flagged"), "Summary should indicate flagging");
    }

    @Test
    @DisplayName("AML check passes for transactions below threshold")
    void testAMLPassesBelowThreshold() {
        Map<String, Object> data = new HashMap<>();
        data.put("transaction_amount", 5000.00);

        ComplianceAuditor.ComplianceResult result = ruleEngine.evaluate("AML", data);

        assertTrue(result.isCompliant(), "AML check should pass for low-value transactions");
        assertTrue(result.getViolations().isEmpty(), "No violations should be reported");
    }

    @Test
    @DisplayName("Unknown check type returns compliant")
    void testUnknownCheckTypeReturnsCompliant() {
        Map<String, Object> data = new HashMap<>();
        data.put("some_field", "some_value");

        ComplianceAuditor.ComplianceResult result = ruleEngine.evaluate("UNKNOWN_CHECK_TYPE", data);

        assertTrue(result.isCompliant(), "Unknown check types should return compliant");
        assertTrue(result.getSummary().contains("assuming compliant"), "Should mention assumption");
    }

    @Test
    @DisplayName("MiFID II check returns compliant stub")
    void testMiFIDReportingStub() {
        Map<String, Object> data = new HashMap<>();

        ComplianceAuditor.ComplianceResult result = ruleEngine.evaluate("MIFID_II_REPORTING", data);

        assertTrue(result.isCompliant(), "MiFID II check should return compliant (stub)");
        assertTrue(result.getSummary().contains("assumed compliant"), "Should indicate stub implementation");
    }
}
