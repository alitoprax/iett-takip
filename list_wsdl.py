import urllib.request
import xml.etree.ElementTree as ET

url = 'https://api.ibb.gov.tr/iett/UlasimAnaVeri/HatDurakGuzergah.asmx?WSDL'
req = urllib.request.Request(url)
with urllib.request.urlopen(req) as resp:
    xml_data = resp.read()
root = ET.fromstring(xml_data)
for child in root.iter():
    if '}operation' in child.tag and 'name' in child.attrib:
        print(child.attrib['name'])
