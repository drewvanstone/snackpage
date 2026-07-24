#!/usr/bin/env ruby
# frozen_string_literal: true

# Update only the release fields owned by snackpage's release workflow.
# Refusing an unexpected formula shape is safer than silently editing the
# wrong line after the tap evolves.

path, archive_url, version, sha256 = ARGV

abort "usage: update-homebrew-formula.rb FORMULA URL VERSION SHA256" unless ARGV.length == 4
version_pattern = /\A(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\z/
archive_pattern = %r{\Ahttps://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/archive/refs/tags/v#{Regexp.escape(version)}\.tar\.gz\z}

abort "invalid release version: #{version.inspect}" unless version.match?(version_pattern)
abort "invalid archive URL: #{archive_url.inspect}" unless archive_url.match?(archive_pattern)
abort "invalid SHA-256: #{sha256.inspect}" unless sha256.match?(/\A[0-9a-f]{64}\z/)

formula = File.read(path)
replacements = {
  /^  url "[^"]+"$/ => %(  url "#{archive_url}"),
  /^  sha256 "[0-9a-f]+"$/ => %(  sha256 "#{sha256}")
}

replacements.each do |pattern, replacement|
  matches = formula.scan(pattern).length
  abort "#{path}: expected one #{pattern.inspect} line, found #{matches}" unless matches == 1

  formula = formula.sub(pattern, replacement)
end

# Homebrew derives this stable version from the tag URL. Older tap revisions
# carried an explicit version line, which strict audit now rejects as redundant.
version_pattern = /^  version "[^"]+"$\n?/
version_matches = formula.scan(version_pattern).length
abort "#{path}: expected at most one explicit version line, found #{version_matches}" if version_matches > 1

formula = formula.sub(version_pattern, "")

temporary_path = "#{path}.snackpage-release-#{Process.pid}"
temporary_created = false
begin
  mode = File.stat(path).mode
  File.open(temporary_path, File::WRONLY | File::CREAT | File::EXCL, mode) do |temporary|
    temporary_created = true
    temporary.write(formula)
    temporary.flush
    temporary.fsync
  end
  File.rename(temporary_path, path)
ensure
  File.delete(temporary_path) if temporary_created && File.exist?(temporary_path)
end
