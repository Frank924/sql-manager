package com.sqlmanager;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public class State {
    public int schemaVersion = 1;
    public long revision;
    public List<Script> scripts = new ArrayList<>();
    public List<Release> releases = new ArrayList<>();
    public List<Environment> environments = new ArrayList<>();
    public List<Delivery> packages = new ArrayList<>();
    public Settings settings = new Settings();

    public static class Settings {
        public String workspaceName = "SQL Manager";
        public String dataDirectory;
    }

    public static class Script {
        public String id, name, description, db, type, createdAt, hash;
        public long size;
        public boolean frozen = true;
    }

    public static class Release {
        public String id, name, date, status, baseline, previous, notes;
        public List<String> scriptIds = new ArrayList<>();
    }

    public static class Environment {
        public String id, name, kind, codeVersion = "", actualDb, db = "business";
        public String baseline, baseBaseline, baseVersion, last;
        public List<String> applied = new ArrayList<>();
        public List<String> baseApplied = new ArrayList<>();
        public List<String> issues = new ArrayList<>();
        public List<History> history = new ArrayList<>();
    }

    public static class History {
        public String date, title, detail, type, operator, note, version;
    }

    public static class Delivery {
        public String id, envId, envName, target, type, db, actualDb, createdAt, status;
        public String operator, executedAt, note, inputBaseline;
        public List<String> scriptIds = new ArrayList<>();
        public List<String> inputApplied = new ArrayList<>();
        public List<Script> files = new ArrayList<>();
        public Map<String, String> results = new LinkedHashMap<>();
        public List<Registration> registrations = new ArrayList<>();
        public EnvironmentSnapshot environmentSnapshot;
    }

    public static class EnvironmentSnapshot {
        public String id, name, db, actualDb, codeVersion, baseline;
    }

    public static class Registration {
        public Map<String, String> results = new LinkedHashMap<>();
        public String operator, executedAt, note, recordedAt;
    }
}
