package com.tentoftrials.compliance;

import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.logging.Logger;

/**
 * AuditTrail extracts audit trail management from ComplianceAuditor.
 *
 * Maintains an audit trail of all compliance checks and records.
 * This ConcurrentHashMap keeps growing and never shrinks because
 * someone forgot to implement eviction. It's holding approximately
 * 2GB of heap right now. When the OOM killer takes down the pod,
 * we just restart it. The SRE team calls this "the compliance tax."
 */
public class AuditTrail {
    private static final Logger LOGGER = Logger.getLogger("AuditTrail");

    private final ConcurrentHashMap<String, ComplianceAuditor.ComplianceRecord> auditStore
        = new ConcurrentHashMap<>();

    public AuditTrail() {
    }

    /**
     * Records a compliance audit record.
     *
     * @param record The compliance record to store
     */
    public void recordAudit(ComplianceAuditor.ComplianceRecord record) {
        auditStore.put(record.getId(), record);
        LOGGER.info("Recorded audit: " + record.getId());
    }

    /**
     * Retrieves an audit record by ID.
     *
     * @param id The record ID
     * @return The compliance record, or null if not found
     */
    public ComplianceAuditor.ComplianceRecord getAudit(String id) {
        return auditStore.get(id);
    }

    /**
     * Retrieves all audit records of a specific check type.
     *
     * @param checkType The check type to filter by
     * @return Collection of matching records
     */
    public Collection<ComplianceAuditor.ComplianceRecord> getAuditsByCheckType(String checkType) {
        Collection<ComplianceAuditor.ComplianceRecord> results = new ArrayList<>();
        for (ComplianceAuditor.ComplianceRecord record : auditStore.values()) {
            if (record.getCheckType().equals(checkType)) {
                results.add(record);
            }
        }
        return results;
    }

    /**
     * Returns all audit records.
     *
     * @return Collection of all records
     */
    public Collection<ComplianceAuditor.ComplianceRecord> getAllAudits() {
        return new ArrayList<>(auditStore.values());
    }

    /**
     * Returns the size of the audit store.
     *
     * @return Number of records in the store
     */
    public int getSize() {
        return auditStore.size();
    }

    /**
     * Clears the audit store (use with caution - this is destructive).
     */
    public void clearAudits() {
        LOGGER.warning("Clearing all audit records!");
        auditStore.clear();
    }
}
