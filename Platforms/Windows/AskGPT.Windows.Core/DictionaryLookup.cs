using Microsoft.Data.Sqlite;
using System.Text.RegularExpressions;

namespace AskGPT.Windows.Core;
public sealed record LookupResult(string Word,string Phonetic,string Translation,string Definition);
public sealed class DictionaryLookup(string path) {
    public async Task<LookupResult?> LookupAsync(string value,CancellationToken ct) {
        ct.ThrowIfCancellationRequested(); var word=value.Trim().Normalize(); word=word.Trim('“','”','‘','’','"','(',')','[',']',',',';','!', '?');
        if(word.Length is <1 or >128 || !Regex.IsMatch(word,@"^[A-Za-z]+(?:[.'’\-][A-Za-z]+)*\.?$",RegexOptions.CultureInvariant) || !File.Exists(path)) return null;
        await using var connection=new SqliteConnection(new SqliteConnectionStringBuilder {DataSource=path,Mode=SqliteOpenMode.ReadOnly,Cache=SqliteCacheMode.Private,Pooling=false}.ToString()); await connection.OpenAsync(ct);
        async Task<LookupResult?> Query(string query,bool exact) {
            await using var command=connection.CreateCommand(); command.CommandText="SELECT word, phonetic, translation FROM entries WHERE word = $word COLLATE "+(exact?"BINARY":"NOCASE")+" ORDER BY word LIMIT 2"; command.Parameters.AddWithValue("$word",query);
            await using var rows=await command.ExecuteReaderAsync(ct); if(!await rows.ReadAsync(ct)) return null;
            var result=new LookupResult(rows.GetString(0),rows.IsDBNull(1)?"":rows.GetString(1),rows.IsDBNull(2)?"":rows.GetString(2),""); return await rows.ReadAsync(ct)?null:result;
        }
        var entry=await Query(word,true) ?? await Query(word,false); if(entry is not null) return entry;
        await using var forms=connection.CreateCommand(); forms.CommandText="SELECT headword FROM forms WHERE form=$word COLLATE NOCASE ORDER BY headword LIMIT 2"; forms.Parameters.AddWithValue("$word",word);
        var names=new List<string>(); await using(var reader=await forms.ExecuteReaderAsync(ct)) while(await reader.ReadAsync(ct)) names.Add(reader.GetString(0));
        return names.Count==1?await Query(names[0],true):null;
    }
}
