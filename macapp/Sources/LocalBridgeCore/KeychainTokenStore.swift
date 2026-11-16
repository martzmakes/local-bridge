import Foundation
import Security

/// The account tokens in this app's own Keychain item (generic password, one per public base).
public struct KeychainTokenStore: TokenStore {
    public let service: String

    public init(service: String = AccountClient.keychainService) {
        self.service = service
    }

    private func query(_ account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    public func load(account: String) throws -> TokenSet? {
        var q = query(account)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data else {
            throw AccountError.network("Keychain read failed (\(status))")
        }
        return try? JSONDecoder().decode(TokenSet.self, from: data)
    }

    public func save(_ tokens: TokenSet, account: String) throws {
        let data = try JSONEncoder().encode(tokens)
        let update = SecItemUpdate(query(account) as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if update == errSecSuccess { return }
        guard update == errSecItemNotFound else {
            throw AccountError.network("Keychain write failed (\(update))")
        }
        var q = query(account)
        q[kSecValueData as String] = data
        q[kSecAttrLabel as String] = "Local Bridge account"
        let add = SecItemAdd(q as CFDictionary, nil)
        guard add == errSecSuccess else { throw AccountError.network("Keychain write failed (\(add))") }
    }

    public func delete(account: String) throws {
        let status = SecItemDelete(query(account) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw AccountError.network("Keychain delete failed (\(status))")
        }
    }
}
